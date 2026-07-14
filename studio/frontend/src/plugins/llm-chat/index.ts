import type { IPlugin } from '../../host/types';
import type { ILlmChatState } from './state';
import { makeInitialState, LLM_CHAT_PLUGIN_ID } from './state';
import { initChat } from './actions';
import { ChatRoomPane } from './ChatRoomPane';
import { SettingsPane } from './SettingsPane';
import { SkillEditorPane } from './SkillEditorPane';

export const llmChat: IPlugin<ILlmChatState> = {
  id: LLM_CHAT_PLUGIN_ID,
  title: 'LLM Chat',
  persist: false,
  initialState: makeInitialState('', null),
  panes: [
    { id: 'llm-chat/room', title: 'Chat Room', component: ChatRoomPane as never },
    { id: 'llm-chat/settings', title: 'Chat Settings', component: SettingsPane as never },
    { id: 'llm-chat/skill-editor', title: 'Skill Editor', component: SkillEditorPane as never },
  ],
  init: () => initChat(),
};
