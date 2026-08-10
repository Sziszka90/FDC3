/**
 * SPDX-License-Identifier: Apache-2.0
 * Copyright FINOS FDC3 contributors - see NOTICE file
 */
import { makeObservable, observable, action, runInAction, toJS } from 'mobx';
import { ContextType, Fdc3Listener, PrivateChannel } from '../utility/Fdc3Api.js';
import systemLogStore from './SystemLogStore.js';
import { nanoid } from 'nanoid';
import { getWorkbenchAgent } from '../utility/Fdc3Api.js';
import { ContextMetadata } from '@finos/fdc3-standard';
import { Listener } from '@finos/fdc3';
// interface ListenerOptionType {
// 	title: string;
// 	value: string;
// 	type: string | undefined;
// }

type PrivateChannelEventType = 'addContextListener' | 'unsubscribe' | 'disconnect';
type PrivateChannelEventHandler = Parameters<PrivateChannel['addEventListener']>[1];
type LegacyPrivateChannel = PrivateChannel & {
  onAddContextListener?: (handler: (contextType?: string) => void) => Listener;
  onUnsubscribe?: (handler: (contextType?: string) => void) => Listener;
  onDisconnect?: (handler: () => void) => Listener;
};

interface PrivateChannelEventListener {
  channelId: string;
  eventType: PrivateChannelEventType;
  listener: Listener;
}

class PrivateChannelStore {
  privateChannelsList: PrivateChannel[] = [];

  currentPrivateChannel: PrivateChannel | null = null;

  channelListeners: Fdc3Listener[] = [];

  eventListeners: PrivateChannelEventListener[] = [];

  constructor() {
    makeObservable(this, {
      privateChannelsList: observable,
      currentPrivateChannel: observable,
      channelListeners: observable,
      eventListeners: observable,
      createPrivateChannel: action,
      broadcast: action,
      onAddContextListener: action,
      onDisconnect: action,
      onUnsubscribe: action,
      disconnect: action,
    });
  }

  private async registerEventListener(
    channel: PrivateChannel,
    eventType: PrivateChannelEventType,
    handler: PrivateChannelEventHandler
  ) {
    const existingListener = this.eventListeners.find(
      listener => listener.channelId === channel.id && listener.eventType === eventType
    );
    if (existingListener) {
      return;
    }

    const legacyChannel = channel as LegacyPrivateChannel;
    let listener: Listener;

    if (typeof channel.addEventListener === 'function') {
      listener = await channel.addEventListener(eventType, handler);
    } else if (eventType === 'addContextListener' && legacyChannel.onAddContextListener) {
      listener = legacyChannel.onAddContextListener(contextType =>
        handler({ type: eventType, details: { contextType: contextType ?? null } })
      );
    } else if (eventType === 'unsubscribe' && legacyChannel.onUnsubscribe) {
      listener = legacyChannel.onUnsubscribe(contextType =>
        handler({ type: eventType, details: { contextType: contextType ?? null } })
      );
    } else if (eventType === 'disconnect' && legacyChannel.onDisconnect) {
      listener = legacyChannel.onDisconnect(() => handler({ type: eventType, details: null }));
    } else {
      throw new Error(`Private channel does not support ${eventType} events`);
    }

    runInAction(() => {
      this.eventListeners.push({
        channelId: channel.id,
        eventType,
        listener,
      });
    });
  }

  private async removeEventListeners(channelId: string) {
    const listeners = this.eventListeners.filter(listener => listener.channelId === channelId);

    await Promise.all(
      listeners.map(async ({ listener }) => {
        try {
          await listener.unsubscribe();
        } catch {
          // The channel may already be disconnected.
        }
      })
    );

    runInAction(() => {
      this.eventListeners = this.eventListeners.filter(listener => listener.channelId !== channelId);
    });
  }

  async createPrivateChannel() {
    try {
      const currentPrivateChannel: PrivateChannel = await getWorkbenchAgent().then(agent =>
        agent.createPrivateChannel()
      );
      const isSuccess = currentPrivateChannel !== null;
      if (isSuccess) {
        this.privateChannelsList.push(currentPrivateChannel);
      }

      runInAction(() => {
        systemLogStore.addLog({
          name: 'createPrivateChannel',
          type: isSuccess ? 'success' : 'error',
          value: currentPrivateChannel.id,
          variant: 'text',
        });
      });

      return currentPrivateChannel;
    } catch (e) {
      systemLogStore.addLog({
        name: 'createPrivateChannel',
        type: 'error',
        value: '',
        variant: 'code',
        body: JSON.stringify(e, null, 4),
      });
    }
  }

  isContextListenerExists(channelId: string, type: string | undefined) {
    return !!this.channelListeners?.find(listener => listener.type === type && listener.channelId === channelId);
  }

  isPrivateChannelExists(channelId: string) {
    return !!this.privateChannelsList.find(channel => channel.id === channelId);
  }

  async broadcast(channel: PrivateChannel, context: ContextType) {
    const channelId = channel.id;
    if (!context) {
      systemLogStore.addLog({
        name: 'appBroadcast',
        type: 'warning',
        value: `You must set a context before you can broadcast it to channel: ${channelId}`,
        variant: 'text',
      });
    }

    if (!channel) {
      systemLogStore.addLog({
        name: 'appBroadcast',
        type: 'warning',
        value: 'You are not currently joined to a channel (no-op)',
        variant: 'text',
      });
      return;
    }

    try {
      await channel.broadcast(toJS(context));
      systemLogStore.addLog({
        name: 'appBroadcast',
        type: 'success',
        body: JSON.stringify(context, null, 4),
        variant: 'code',
        value: channelId,
      });
    } catch (e) {
      systemLogStore.addLog({
        name: 'appBroadcast',
        type: 'error',
        body: JSON.stringify(e, null, 4),
        variant: 'code',
        value: channelId,
      });
    }
  }

  async addChannelListener(currentChannel: PrivateChannel, newListener: string | undefined) {
    const channelId = currentChannel.id;
    try {
      const foundListener = this.channelListeners.find(
        currentListener => currentListener.type === newListener && currentListener.channelId === channelId
      );
      if (!foundListener && currentChannel && newListener !== undefined) {
        const listenerId = nanoid();
        const contactListener = await currentChannel.addContextListener(
          newListener?.toLowerCase() === 'all' ? null : newListener,
          (context, metaData?: ContextMetadata) => {
            const currentListener = this.channelListeners.find(
              listener => listener.type === newListener && listener.channelId === channelId
            );

            runInAction(() => {
              if (currentListener) {
                currentListener.lastReceivedContext = context;
                currentListener.metaData = metaData;
              }
            });

            systemLogStore.addLog({
              name: 'receivedAppContextListener',
              type: 'info',
              value: `Channel [${channelId}] Received context via '[${newListener}]' listener`,
              variant: 'code',
              body: JSON.stringify(context, null, 4),
            });
          }
        );

        runInAction(() => {
          this.channelListeners.push({
            id: listenerId,
            type: newListener,
            listener: contactListener,
            channelId,
          });
        });
      }
    } catch {
      /* empty */
    }
  }

  removeContextListener(id: string) {
    const listenerIndex = this.channelListeners?.findIndex(listener => listener.id === id);
    const listener = this.channelListeners[listenerIndex];
    if (listenerIndex !== -1) {
      try {
        this.channelListeners[listenerIndex].listener.unsubscribe();

        runInAction(() => {
          systemLogStore.addLog({
            name: 'removeAppChannelContextListener',
            type: 'success',
            value: `A context listener for '[${listener.type}]' for channel [${listener.channelId}] has been removed`,
            variant: 'text',
          });
          this.channelListeners.splice(listenerIndex, 1);
        });
      } catch (e) {
        systemLogStore.addLog({
          name: 'removeAppChannelContextListener',
          type: 'error',
          value: `Failed to remove a context listener for '[${listener.type}]' on channel [${listener.channelId}]`,
          variant: 'code',
          body: JSON.stringify(e, null, 4),
        });
      }
    }
  }

  async onAddContextListener(
    channel: PrivateChannel,
    channelContexts?: Record<string, ContextType>,
    channelContextDelay?: Record<string, number>
  ) {
    try {
      await this.registerEventListener(channel, 'addContextListener', event => {
        try {
          const contextType = event.details.contextType;
          const contextTypeLabel = contextType ?? '[all]';

          systemLogStore.addLog({
            name: 'pcAddContextListener',
            type: 'success',
            value: `A context listener for '${contextTypeLabel}' has been added on channel [${channel.id}]`,
          });

          if (channelContexts && Object.keys(channelContexts).length !== 0) {
            Object.entries(channelContexts)
              .filter(([, context]) => contextType === null || context.type === contextType)
              .forEach(([key, context]) => {
                const broadcast = setTimeout(async () => {
                  this.broadcast(channel, context);
                  clearTimeout(broadcast);
                }, channelContextDelay?.[key] ?? 0);
              });
          }
        } catch {
          systemLogStore.addLog({
            name: 'pcAddContextListener',
            type: 'error',
            value: `Failed to add a context listener on channel [${channel.id}]`,
          });
        }
      });
    } catch {
      systemLogStore.addLog({
        name: 'pcAddContextListener',
        type: 'error',
        value: `Failed to register addContextListener events on channel [${channel.id}]`,
      });
    }
  }

  async onUnsubscribe(channel: PrivateChannel) {
    try {
      await this.registerEventListener(channel, 'unsubscribe', event => {
        try {
          const contextType = event.details.contextType;
          const contextTypeLabel = contextType ?? '[all]';

          systemLogStore.addLog({
            name: 'pcOnUnsubscribe',
            type: 'success',
            value: `Successfully unsubscribed from listener '${contextTypeLabel}' for channel [${channel.id}]`,
          });
        } catch {
          systemLogStore.addLog({
            name: 'pcOnUnsubscribe',
            type: 'error',
            value: `Could not unsubscribe listener from channel [${channel.id}]`,
          });
        }
      });
    } catch {
      systemLogStore.addLog({
        name: 'pcOnUnsubscribe',
        type: 'error',
        value: `Failed to register unsubscribe events on channel [${channel.id}]`,
      });
    }
  }

  async onDisconnect(channel: PrivateChannel) {
    try {
      await this.registerEventListener(channel, 'disconnect', async () => {
        try {
          this.channelListeners
            .filter(listener => listener.channelId === channel.id)
            .forEach(listener => {
              this.removeContextListener(listener.id);
            });
          await this.removeEventListeners(channel.id);
          runInAction(() => {
            this.privateChannelsList = this.privateChannelsList.filter(chan => chan.id !== channel.id);
          });
          systemLogStore.addLog({
            name: 'pcOnDisconnect',
            type: 'success',
            value: `Successfully disconnected from channel [${channel.id}]`,
          });
        } catch {
          systemLogStore.addLog({
            name: 'pcOnDisconnect',
            type: 'error',
            value: `Unable to disconnect from channel [${channel.id}]`,
          });
        }
      });
    } catch {
      systemLogStore.addLog({
        name: 'pcOnDisconnect',
        type: 'error',
        value: `Failed to register disconnect events on channel [${channel.id}]`,
      });
    }
  }

  async disconnect(channel: PrivateChannel) {
    this.channelListeners
      .filter(listener => listener.channelId === channel.id)
      .forEach(listener => {
        this.removeContextListener(listener.id);
      });
    await this.removeEventListeners(channel.id);
    runInAction(() => {
      this.privateChannelsList = this.privateChannelsList.filter(chan => chan.id !== channel.id);
    });
    await channel.disconnect();
  }
}

const privateChannelStore = new PrivateChannelStore();

export default privateChannelStore;
