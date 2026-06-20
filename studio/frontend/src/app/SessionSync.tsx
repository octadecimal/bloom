import { useEffect } from 'react';
import { useSession } from '../session/SessionContext';
import { connectChatAs, disconnectChat } from '../plugins/llm-chat/actions';

export function SessionSync() {
  const { username } = useSession();
  useEffect(() => {
    if (username) connectChatAs(username);
    else disconnectChat();
  }, [username]);
  return null;
}
