import { Platform } from 'react-native';
import { AudioManager } from 'react-native-audio-api';

import {
  applyVoisaOutputRoute,
  startOutputRouteSync,
  stopOutputRouteSync,
  type VoisaOutputRoute,
} from '@/lib/audio/listeningMode';

export type { VoisaOutputRoute };

/**
 * Call-like session for live translate:
 * - `voiceChat` enables platform AEC so the mic picks up speech cleanly.
 * - No `defaultToSpeaker` — output follows headphones or earpiece (see listeningMode).
 * - Bluetooth allowed so wireless headsets work without forcing the loudspeaker.
 */
export async function prepareVoisaAudioSession(
  onOutputRoute?: (route: VoisaOutputRoute) => void,
): Promise<VoisaOutputRoute> {
  AudioManager.setAudioSessionOptions({
    iosCategory: 'playAndRecord',
    iosMode: 'voiceChat',
    iosOptions: ['allowBluetoothHFP', 'allowBluetoothA2DP', 'mixWithOthers'],
  });

  if (Platform.OS === 'android') {
    AudioManager.observeAudioInterruptions('gain');
  }

  const permissions = await AudioManager.requestRecordingPermissions();
  if (permissions !== 'Granted') {
    throw new Error('Microphone permission was not granted.');
  }

  const active = await AudioManager.setAudioSessionActivity(true);
  if (!active) {
    throw new Error('Could not activate the audio session.');
  }

  const route = await applyVoisaOutputRoute();
  onOutputRoute?.(route);
  startOutputRouteSync(onOutputRoute);
  return route;
}

export async function teardownVoisaAudioSession(): Promise<void> {
  stopOutputRouteSync();
  if (Platform.OS === 'android') {
    AudioManager.observeAudioInterruptions(false);
  }
  try {
    await AudioManager.setAudioSessionActivity(false);
  } catch {
    /* ignore */
  }
}
