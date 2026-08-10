/**
 * SPDX-License-Identifier: Apache-2.0
 * Copyright FINOS FDC3 contributors - see NOTICE file
 */
import { makeObservable, observable, action, runInAction } from 'mobx';
import systemLogStore from './SystemLogStore.js';
import { Channel, Listener } from '@finos/fdc3';
import { getWorkbenchAgent } from '../utility/Fdc3Api.js';

class ChannelStore {
  userChannels: Channel[] = [];

  currentUserChannel: Channel | null = null;

  userChannelChangedListener: Listener | null = null;

  constructor() {
    makeObservable(this, {
      userChannels: observable,
      currentUserChannel: observable,
      userChannelChangedListener: observable,
      getUserChannels: action,
      joinUserChannel: action,
      leaveUserChannel: action,
      getCurrentUserChannel: action,
    });

    this.getUserChannels();
  }

  async getCurrentUserChannel() {
    const agent = await getWorkbenchAgent();
    try {
      const userChannel = await agent.getCurrentChannel();
      runInAction(() => {
        systemLogStore.addLog({
          name: 'getCurrentChannel',
          type: 'success',
          value: userChannel ? userChannel.id : 'none',
          variant: 'text',
        });
        this.currentUserChannel = userChannel;
      });
    } catch (e) {
      runInAction(() => {
        systemLogStore.addLog({
          name: 'getCurrentChannel',
          type: 'error',
          body: (e as Error).message ?? (e as string),
          variant: 'text',
        });
      });
    }
  }

  async getUserChannels() {
    const agent = await getWorkbenchAgent();
    //defer retrieving channels until fdc3 API is ready
    try {
      const legacyAgent = agent as typeof agent & {
        getSystemChannels?: () => Promise<Channel[]>;
      };
      if (!this.userChannelChangedListener && typeof agent.addEventListener === 'function') {
        try {
          this.userChannelChangedListener = await agent.addEventListener('userChannelChanged', async event => {
            try {
              const currentChannelId = event.details.currentChannelId;
              const changedUserChannel = currentChannelId
                ? (this.userChannels.find(channel => channel.id === currentChannelId) ??
                  (await agent.getCurrentChannel()))
                : null;

              runInAction(() => {
                systemLogStore.addLog({
                  name: 'userChannelChanged',
                  type: 'info',
                  value: currentChannelId ?? 'none',
                  variant: 'text',
                });
                this.currentUserChannel = changedUserChannel;
              });
            } catch (e) {
              systemLogStore.addLog({
                name: 'userChannelChanged',
                type: 'error',
                body: (e as Error).message ?? (e as string),
                variant: 'text',
              });
            }
          });
        } catch (e) {
          systemLogStore.addLog({
            name: 'userChannelChanged',
            type: 'error',
            body: (e as Error).message ?? (e as string),
            variant: 'text',
          });
        }
      }

      const userChannels: Channel[] =
        typeof agent.getUserChannels === 'function'
          ? await agent.getUserChannels()
          : legacyAgent.getSystemChannels
            ? await legacyAgent.getSystemChannels()
            : (() => {
                throw new Error('The Desktop Agent does not support User or System Channels');
              })();
      const currentUserChannel = await agent.getCurrentChannel();

      runInAction(() => {
        systemLogStore.addLog({
          name: 'getChannels',
          type: 'success',
        });
        this.userChannels = userChannels;
        this.currentUserChannel = currentUserChannel;
      });
    } catch (e) {
      console.error('Failed to retrieve user channels: ', e);
      systemLogStore.addLog({
        name: 'getChannels',
        type: 'error',
        variant: 'code',
        body: JSON.stringify(e, null, 4),
      });
    }
  }

  async joinUserChannel(channelId: string) {
    const agent = await getWorkbenchAgent();
    try {
      const legacyAgent = agent as typeof agent & {
        joinChannel?: (channelId: string) => Promise<void>;
      };
      if (typeof agent.joinUserChannel === 'function') {
        await agent.joinUserChannel(channelId);
      } else if (legacyAgent.joinChannel) {
        await legacyAgent.joinChannel(channelId);
      } else {
        throw new Error('The Desktop Agent does not support joining User or System Channels');
      }
      let isSuccess = true;

      if (!this.userChannelChangedListener) {
        const currentUserChannel = await agent.getCurrentChannel();
        isSuccess = currentUserChannel !== null;
        runInAction(() => {
          this.currentUserChannel = currentUserChannel;
        });
      }

      runInAction(() => {
        systemLogStore.addLog({
          name: 'joinUserChannel',
          type: isSuccess ? 'success' : 'error',
          value: isSuccess ? this.currentUserChannel?.id : channelId,
          variant: 'text',
        });
      });
    } catch (e) {
      systemLogStore.addLog({
        name: 'joinUserChannel',
        type: 'error',
        value: channelId,
        variant: 'code',
        body: JSON.stringify(e, null, 4),
      });
    }
  }

  async leaveUserChannel() {
    const agent = await getWorkbenchAgent();
    try {
      //check that we're on a channel
      const currentUserChannel = this.currentUserChannel;
      if (!currentUserChannel) {
        systemLogStore.addLog({
          name: 'leaveChannel',
          type: 'warning',
          value: '',
          variant: 'text',
        });
      } else {
        await agent.leaveCurrentChannel();
        let isSuccess = true;

        if (!this.userChannelChangedListener) {
          const updatedUserChannel = await agent.getCurrentChannel();
          isSuccess = updatedUserChannel === null;

          runInAction(() => {
            this.currentUserChannel = updatedUserChannel;
          });
        }

        runInAction(() => {
          systemLogStore.addLog({
            name: 'leaveChannel',
            type: isSuccess ? 'success' : 'error',
            value: currentUserChannel.id,
            variant: 'text',
          });
        });
      }
    } catch (e) {
      systemLogStore.addLog({
        name: 'leaveChannel',
        type: 'error',
        value: this.currentUserChannel?.id,
        variant: 'code',
        body: JSON.stringify(e, null, 4),
      });
    }
  }
}

const channelStore = new ChannelStore();

export default channelStore;
