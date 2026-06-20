import type { IPlugin } from '../../host/types';
import type { ILlmChatState } from './state';
import { makeInitialState, LLM_CHAT_PLUGIN_ID } from './state';
import { generateGuestName } from './prefs';
import { initChat } from './actions';
import { RoomListPane } from './RoomListPane';
import { ChatRoomPane } from './ChatRoomPane';
import { SettingsPane } from './SettingsPane';

export const llmChat: IPlugin<ILlmChatState> = {
  id: LLM_CHAT_PLUGIN_ID,
  title: 'LLM Chat',
  persist: false,
  // Real prefs are loaded in initChat(); this seed keeps the slice well-typed pre-init.
  initialState: makeInitialState(generateGuestName(), null),
  panes: [
    { id: 'llm-chat/rooms', title: 'Rooms', component: RoomListPane as never },
    { id: 'llm-chat/room', title: 'Chat Room', component: ChatRoomPane as never },
    { id: 'llm-chat/settings', title: 'Chat Settings', component: SettingsPane as never },
  ],
  commands: [
    { id: 'llm-chat/open-rooms', title: 'Open Room List', run: (host) => host.openPane('llm-chat/rooms') },
    { id: 'llm-chat/open-room', title: 'Open Chat Room', run: (host) => host.openPane('llm-chat/room') },
    { id: 'llm-chat/open-settings', title: 'Open Chat Settings', run: (host) => host.openPane('llm-chat/settings') },
  ],
  init: () => initChat(),
};
