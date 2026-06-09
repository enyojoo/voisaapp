import { setAudioModeAsync } from 'expo-audio';
import { Platform } from 'react-native';
import { AudioManager } from 'react-native-audio-api';

export type VoisaOutputRoute = 'headphones' | 'earpiece';

const HEADPHONE_HINT =
  /headphone|headset|earbud|airpod|bluetooth|a2dp|hfp|usb|wired|line out|line-out/i;

function deviceLooksLikeHeadphones(name: string, category: string): boolean {
  const hay = `${name} ${category}`.toLowerCase();
  return HEADPHONE_HINT.test(hay);
}

/** True when wired or wireless headphones/headset are the active or available output. */
export async function headphonesConnected(): Promise<boolean> {
  try {
    const info = await AudioManager.getDevicesInfo();
    const outputs = [...info.currentOutputs, ...info.availableOutputs];
    return outputs.some((d) => deviceLooksLikeHeadphones(d.name, d.category));
  } catch {
    return false;
  }
}

/**
 * Google Translate–style routing:
 * - Headphones connected → let the OS route translated audio there (private, full tone).
 * - No headphones → earpiece/receiver (hold phone to ear like a call).
 */
function shouldRouteThroughEarpieceForPlatform(hasHeadphones: boolean): boolean {
  /**
   * expo-audio Android maps `shouldRouteThroughEarpiece: false` to MODE_NORMAL +
   * setSpeakerphoneOn(true), which forces the loudspeaker and breaks wired/BT headsets.
   * Keep communication mode + speakerphone off on Android in all cases.
   */
  if (Platform.OS === 'android') return true;
  return !hasHeadphones;
}

export async function applyVoisaOutputRoute(): Promise<VoisaOutputRoute> {
  const hasHeadphones = await headphonesConnected();
  try {
    await setAudioModeAsync({
      allowsRecording: true,
      playsInSilentMode: true,
      interruptionMode: 'doNotMix',
      shouldRouteThroughEarpiece: shouldRouteThroughEarpieceForPlatform(hasHeadphones),
      shouldPlayInBackground: false,
    });
  } catch {
    /* transient category conflicts while session is reconfiguring */
  }
  return hasHeadphones ? 'headphones' : 'earpiece';
}

type RouteSubscription = ReturnType<typeof AudioManager.addSystemEventListener>;
let routeSubscription: RouteSubscription | null = null;

/** Re-apply routing when headphones are plugged/unplugged mid-session. */
export function startOutputRouteSync(
  onRoute?: (route: VoisaOutputRoute) => void,
): void {
  stopOutputRouteSync();
  void applyVoisaOutputRoute().then((route) => onRoute?.(route));
  routeSubscription =
    AudioManager.addSystemEventListener('routeChange', () => {
      void applyVoisaOutputRoute().then((route) => onRoute?.(route));
    }) ?? null;
}

export function stopOutputRouteSync(): void {
  routeSubscription?.remove();
  routeSubscription = null;
}
