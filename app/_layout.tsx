import '@/lib/polyfills/install';

import { DefaultTheme, ThemeProvider } from 'expo-router/react-navigation';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { useEffect } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { configureVoisaRuntimeLogging } from '@/lib/logging/configureClientLogging';
import { AuthProvider, useAuth } from '@/providers/AuthProvider';
import { colors } from '@/theme/tokens';

export { ErrorBoundary } from 'expo-router';

SplashScreen.preventAutoHideAsync();
configureVoisaRuntimeLogging();

export default function RootLayout() {
  const [loaded, error] = useFonts({
    SpaceMono: require('../assets/fonts/SpaceMono-Regular.ttf'),
  });

  useEffect(() => {
    if (error) throw error;
  }, [error]);

  if (!loaded) {
    return null;
  }

  return (
    <SafeAreaProvider>
      <AuthProvider>
        <SplashGate />
      </AuthProvider>
    </SafeAreaProvider>
  );
}

function SplashGate() {
  const { loading } = useAuth();

  useEffect(() => {
    if (!loading) {
      void SplashScreen.hideAsync();
    }
  }, [loading]);

  if (loading) {
    return null;
  }

  return <RootLayoutNav />;
}

function RootLayoutNav() {
  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(colors.background);
  }, []);

  return (
    <>
      <StatusBar style="dark" />
      <ThemeProvider value={DefaultTheme}>
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="index" />
          <Stack.Screen name="(auth)" />
          <Stack.Screen name="(app)" />
        </Stack>
      </ThemeProvider>
    </>
  );
}
