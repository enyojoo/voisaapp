import { lazy, Suspense } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors } from '@/theme/tokens';

const TranslateImpl = lazy(() => import('@/screens/TranslateImplScreen'));

export default function TranslateScreen() {
  return (
    <Suspense
      fallback={
        <SafeAreaView style={styles.safe}>
          <View style={styles.fallback}>
            <ActivityIndicator size="large" color={colors.primary} />
          </View>
        </SafeAreaView>
      }
    >
      <TranslateImpl />
    </Suspense>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  fallback: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
