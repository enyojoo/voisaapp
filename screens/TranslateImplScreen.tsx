import Ionicons from '@expo/vector-icons/Ionicons';
import { requestRecordingPermissionsAsync } from 'expo-audio';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Dimensions,
  FlatList,
  Keyboard,
  LayoutAnimation,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppHeader } from '@/components/AppHeader';
import { useGeminiLiveTranslator } from '@/hooks/useGeminiLiveTranslator';
import { configureVoisaRuntimeLogging } from '@/lib/logging/configureClientLogging';
import { GEMINI_LANGUAGES, geminiLanguageLabel, type GeminiLanguage } from '@/lib/geminiLanguages';
import { useTranslatorLifecycle } from '@/providers/TranslatorLifecycleProvider';
import { colors, spacing } from '@/theme/tokens';

const WINDOW_HEIGHT = Dimensions.get('window').height;

export default function TranslateScreenImpl() {
  const { registerTranslatorStop } = useTranslatorLifecycle();
  const gem = useGeminiLiveTranslator();
  const insets = useSafeAreaInsets();
  const [micError, setMicError] = useState<string | null>(null);
  const transcriptScrollRef = useRef<ScrollView>(null);
  const pickerListRef = useRef<FlatList<GeminiLanguage>>(null);
  const activePairKeyRef = useRef<string | null>(null);

  /** Left dock pill = language A; right = language B (Gemini target is language B with echo). */
  const [languageLeft, setLanguageLeft] = useState('en');
  const [languageRight, setLanguageRight] = useState('es');
  const [pickerSlot, setPickerSlot] = useState<'left' | 'right' | null>(null);
  const [pickerQuery, setPickerQuery] = useState('');

  useEffect(() => {
    configureVoisaRuntimeLogging();
  }, []);

  /** Tap → listening UI immediately (Google Translate–style); cleared on stop or failed start. */
  const [sessionStartedOnTap, setSessionStartedOnTap] = useState(false);

  const connecting = gem.connection === 'connecting';
  const active = gem.connection === 'connected' || gem.connection === 'reconnecting';
  const inSessionUi =
    sessionStartedOnTap || gem.micLive || active || connecting || gem.connection === 'reconnecting';
  const bodyFade = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (gem.connection === 'idle' || gem.connection === 'error') {
      setSessionStartedOnTap(false);
      activePairKeyRef.current = null;
    }
  }, [gem.connection]);

  useEffect(() => {
    if (!inSessionUi) {
      void gem.warmupSession({ languageA: languageLeft, languageB: languageRight });
    }
  }, [inSessionUi, languageLeft, languageRight, gem]);

  useEffect(() => {
    void requestRecordingPermissionsAsync();
  }, []);

  const hasLiveOriginal = gem.liveOriginal.trim().length > 0;
  const hasLiveTranslated = gem.liveTranslated.trim().length > 0;
  const hasGeminiLive = hasLiveOriginal || hasLiveTranslated;

  const listeningIdle =
    inSessionUi &&
    gem.segments.length === 0 &&
    !hasGeminiLive &&
    (gem.micLive || connecting);

  const hasLiveLine = inSessionUi && hasLiveOriginal;

  const bodyViewMode: 'home' | 'listening' | 'transcript' = !inSessionUi
    ? 'home'
    : listeningIdle
      ? 'listening'
      : 'transcript';

  useEffect(() => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    bodyFade.setValue(0.9);
    Animated.timing(bodyFade, {
      toValue: 1,
      duration: 170,
      useNativeDriver: true,
    }).start();
  }, [bodyFade, bodyViewMode]);

  const liveOriginalDisplay = gem.liveOriginal.trim();

  /**
   * Three pulsing dots shown in the translated slot while original tokens are arriving but Gemini has not emitted
   * translation tokens for the current chunk yet. Sized to match the translated text so the live card never
   * collapses or appears empty.
   */
  const dot1 = useRef(new Animated.Value(0.25)).current;
  const dot2 = useRef(new Animated.Value(0.25)).current;
  const dot3 = useRef(new Animated.Value(0.25)).current;
  const showTranslatingPulse =
    hasLiveLine && !hasLiveTranslated && liveOriginalDisplay.length > 0;
  useEffect(() => {
    if (!showTranslatingPulse) {
      dot1.setValue(0.25);
      dot2.setValue(0.25);
      dot3.setValue(0.25);
      return;
    }
    const bounce = (v: Animated.Value, delay: number) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(v, { toValue: 1, duration: 280, useNativeDriver: true }),
          Animated.timing(v, { toValue: 0.25, duration: 280, useNativeDriver: true }),
          Animated.delay(180),
        ]),
      );
    const a = bounce(dot1, 0);
    const b = bounce(dot2, 140);
    const c = bounce(dot3, 280);
    a.start();
    b.start();
    c.start();
    return () => {
      a.stop();
      b.stop();
      c.stop();
    };
  }, [showTranslatingPulse, dot1, dot2, dot3]);

  useEffect(() => {
    if (!active) return;
    const id = requestAnimationFrame(() => {
      transcriptScrollRef.current?.scrollToEnd({ animated: true });
    });
    return () => cancelAnimationFrame(id);
  }, [active, gem.segments.length, gem.liveTranslated, gem.liveOriginal]);

  /** Locked ephemeral token — reconnect when the language pair changes mid-session. */
  useEffect(() => {
    if (!inSessionUi) return;
    if (gem.connection !== 'connected') return;
    const key = `${languageLeft}|${languageRight}`;
    if (activePairKeyRef.current === null) {
      activePairKeyRef.current = key;
      return;
    }
    if (activePairKeyRef.current === key) return;
    activePairKeyRef.current = key;
    void (async () => {
      await gem.stopSession();
      try {
        await gem.startSession({ languageA: languageLeft, languageB: languageRight });
      } catch {
        /* surfaced via lastError */
      }
    })();
  }, [inSessionUi, gem.connection, languageLeft, languageRight, gem]);

  const swapLanguages = useCallback(() => {
    setLanguageLeft(languageRight);
    setLanguageRight(languageLeft);
  }, [languageLeft, languageRight]);

  const pickLanguage = useCallback((slot: 'left' | 'right', code: string) => {
    Keyboard.dismiss();
    const c = code.trim().toLowerCase();
    if (slot === 'left') {
      if (c === languageRight) {
        setLanguageRight(languageLeft);
        setLanguageLeft(c);
      } else {
        setLanguageLeft(c);
      }
    } else if (c === languageLeft) {
      setLanguageLeft(languageRight);
      setLanguageRight(c);
    } else {
      setLanguageRight(c);
    }
    setPickerSlot(null);
  }, [languageLeft, languageRight]);

  useEffect(() => {
    if (pickerSlot === null) setPickerQuery('');
  }, [pickerSlot]);

  const filteredPickerLanguages = useMemo(() => {
    const q = pickerQuery.trim().toLowerCase();
    const base = q
      ? GEMINI_LANGUAGES.filter(
          (l) =>
            l.label.toLowerCase().includes(q) ||
            l.code.toLowerCase().includes(q),
        )
      : GEMINI_LANGUAGES;

    if (!pickerSlot) return base;

    const sel =
      pickerSlot === 'left'
        ? languageLeft.trim().toLowerCase()
        : languageRight.trim().toLowerCase();

    const selectedItem = base.find((l) => l.code === sel);
    if (!selectedItem) return base;

    const rest = base.filter((l) => l.code !== sel);
    return [selectedItem, ...rest];
  }, [pickerQuery, pickerSlot, languageLeft, languageRight]);

  useEffect(() => {
    if (pickerSlot === null) return;
    const id = requestAnimationFrame(() => {
      pickerListRef.current?.scrollToOffset({ offset: 0, animated: false });
    });
    return () => cancelAnimationFrame(id);
  }, [pickerSlot, pickerQuery, filteredPickerLanguages]);

  const closePicker = useCallback(() => {
    Keyboard.dismiss();
    setPickerSlot(null);
  }, []);

  const start = useCallback(() => {
    setSessionStartedOnTap(true);
    setMicError(null);
    gem.clearSegments();

    void (async () => {
      const perm = await requestRecordingPermissionsAsync();
      if (!perm.granted) {
        setSessionStartedOnTap(false);
        setMicError('Microphone permission is required.');
        return;
      }

      try {
        await gem.startSession({
          languageA: languageLeft,
          languageB: languageRight,
        });
        activePairKeyRef.current = `${languageLeft}|${languageRight}`;
      } catch {
        setSessionStartedOnTap(false);
        /** `lastError` + connection state surfaced in banners */
      }
    })();
  }, [gem, languageLeft, languageRight]);

  const stop = useCallback(async () => {
    setSessionStartedOnTap(false);
    await gem.stopSession();
  }, [gem]);

  const toggleSession = useCallback(() => {
    if (inSessionUi) void stop();
    else void start();
  }, [inSessionUi, start, stop]);

  useEffect(() => {
    registerTranslatorStop(stop);
    return () => registerTranslatorStop(null);
  }, [stop, registerTranslatorStop]);

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <AppHeader />

      {gem.lastError ? <Text style={styles.banner}>{gem.lastError}</Text> : null}
      {micError ? <Text style={styles.banner}>{micError}</Text> : null}

      <Animated.View style={[styles.body, { opacity: bodyFade }]}>
        {bodyViewMode === 'home' ? (
          <View style={styles.bodyCenter}>
            <View style={styles.hero}>
              <Text style={styles.heroTitle}>Live Translator</Text>
              <Text style={styles.heroSubtitle}>
                Tap mic to translate. Use headphones, or hold the phone to your ear to hear
                translations privately.
              </Text>
            </View>
          </View>
        ) : bodyViewMode === 'listening' ? (
          <View style={styles.bodyCenter}>
            <View style={styles.hero}>
              <Text style={styles.listening}>Listening…</Text>
              <Text style={styles.listeningHint}>
                {gem.outputRoute === 'headphones'
                  ? 'Audio plays through your headphones.'
                  : 'Hold the phone to your ear to hear translations privately.'}
              </Text>
            </View>
          </View>
        ) : (
          <ScrollView
            ref={transcriptScrollRef}
            style={styles.transcriptScroll}
            contentContainerStyle={styles.transcriptScrollContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator
            accessibilityLiveRegion="polite"
          >
            {gem.segments.map((item) => {
              /**
               * If the live partial is a continuation of THIS segment (sliding pause window), render it inline so
               * the user sees ONE growing card per thread — no separate "live" card flashing in/out below.
               */
              const isContinuation = gem.liveContinuationSegmentId === item.id;
              const continuationTranslated = isContinuation
                ? gem.liveTranslated.trim()
                : '';
              const continuationOriginal = isContinuation
                ? gem.liveOriginal.trim()
                : '';
              const showInlinePulse =
                isContinuation && !continuationTranslated && (continuationOriginal.length > 0);
              const translatedDisplay = continuationTranslated
                ? `${item.translated.trim()} ${continuationTranslated}`.trim()
                : item.translated.trim();
              const originalDisplay = continuationOriginal
                ? `${item.original.trim()} ${continuationOriginal}`.trim()
                : item.original.trim();
              return (
                <View key={item.id} style={styles.transcriptCard}>
                  <Text
                    style={styles.originalSecondary}
                    selectable
                    accessibilityHint={`Spoken (${geminiLanguageLabel(languageLeft)})`}
                  >
                    {originalDisplay || '…'}
                  </Text>

                  <View style={styles.transcriptDivider} />

                  {translatedDisplay ? (
                    <Text
                      style={styles.translationPrimary}
                      selectable
                      accessibilityHint={`Translated (${geminiLanguageLabel(languageRight)})`}
                    >
                      {translatedDisplay}
                    </Text>
                  ) : null}
                  {showInlinePulse ? (
                    <View
                      style={styles.translatingPulseRow}
                      accessibilityLabel="Translating"
                      accessibilityHint={`Translating to ${geminiLanguageLabel(languageRight)}`}
                    >
                      <Animated.View style={[styles.translatingDot, { opacity: dot1 }]} />
                      <Animated.View style={[styles.translatingDot, { opacity: dot2 }]} />
                      <Animated.View style={[styles.translatingDot, { opacity: dot3 }]} />
                    </View>
                  ) : null}
                  {!translatedDisplay && !showInlinePulse ? (
                    <Text
                      style={styles.translationPrimary}
                      selectable={false}
                      accessibilityHint={`Translated (${geminiLanguageLabel(languageRight)})`}
                    >
                      …
                    </Text>
                  ) : null}
                </View>
              );
            })}

            {hasLiveLine && gem.liveContinuationSegmentId === null ? (
              <View style={styles.transcriptCard} accessibilityLiveRegion="polite">
                <Text
                  style={styles.originalSecondary}
                  selectable
                  accessibilityHint={`Spoken (${geminiLanguageLabel(languageLeft)})`}
                >
                  {liveOriginalDisplay}
                </Text>

                <View style={styles.transcriptDivider} />

                {hasLiveTranslated ? (
                  <Text
                    style={styles.translationPrimary}
                    selectable
                    accessibilityHint={`Translated (${geminiLanguageLabel(languageRight)})`}
                  >
                    {gem.liveTranslated.trim()}
                  </Text>
                ) : (
                  <View
                    style={styles.translatingPulseRow}
                    accessibilityLabel="Translating"
                    accessibilityHint={`Translating to ${geminiLanguageLabel(languageRight)}`}
                  >
                    <Animated.View style={[styles.translatingDot, { opacity: dot1 }]} />
                    <Animated.View style={[styles.translatingDot, { opacity: dot2 }]} />
                    <Animated.View style={[styles.translatingDot, { opacity: dot3 }]} />
                  </View>
                )}
              </View>
            ) : null}

          </ScrollView>
        )}
      </Animated.View>

      <View style={[styles.dock, { paddingBottom: Math.max(insets.bottom, spacing.md) }]}>
        <View style={styles.langRow}>
          <Pressable
            style={styles.langPill}
            onPress={() => setPickerSlot('left')}
            accessibilityRole="button"
          >
            <Text style={styles.langPillText} numberOfLines={1}>
              {geminiLanguageLabel(languageLeft)}
            </Text>
          </Pressable>
          <Pressable
            style={styles.swapBtn}
            onPress={swapLanguages}
            accessibilityRole="button"
            accessibilityLabel="Swap languages"
            hitSlop={12}
          >
            <Ionicons name="swap-horizontal" size={22} color={colors.textSecondary} />
          </Pressable>
          <Pressable
            style={styles.langPill}
            onPress={() => setPickerSlot('right')}
            accessibilityRole="button"
          >
            <Text style={styles.langPillText} numberOfLines={1}>
              {geminiLanguageLabel(languageRight)}
            </Text>
          </Pressable>
        </View>

        <Pressable
          style={[styles.micFab, inSessionUi && styles.micFabActive]}
          onPress={() => void toggleSession()}
          accessibilityRole="button"
          accessibilityLabel={
            inSessionUi ? 'Stop translation session' : 'Start translation session'
          }
        >
          <Ionicons
            name={inSessionUi ? 'stop-circle' : 'mic'}
            size={inSessionUi ? 44 : 38}
            color="#fff"
          />
        </Pressable>
      </View>

      <Modal
        visible={pickerSlot !== null}
        transparent
        animationType="slide"
        onRequestClose={closePicker}
      >
        <View style={styles.modalOuter}>
          <Pressable
            style={styles.modalBackdropFill}
            onPress={closePicker}
            accessibilityRole="button"
            accessibilityLabel="Dismiss language picker"
          />
          <SafeAreaView style={styles.modalSafeTop} edges={['top', 'left', 'right']} pointerEvents="box-none">
            <KeyboardAvoidingView
              style={styles.modalKbRoot}
              behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
              keyboardVerticalOffset={0}
              pointerEvents="box-none"
            >
              <View style={styles.modalRoot} pointerEvents="box-none">
                <View
                  style={[
                    styles.modalSheet,
                    {
                      height: Math.round(WINDOW_HEIGHT * 0.62),
                      maxHeight: Math.round(WINDOW_HEIGHT * 0.88),
                      paddingBottom: Math.max(insets.bottom, spacing.md),
                    },
                  ]}
                  pointerEvents="auto"
                >
                  <Text style={styles.modalTitle}>
                    {pickerSlot === 'left' ? 'Translate from' : 'Translate to'}
                  </Text>

                  <View style={styles.searchRow}>
                    <Ionicons name="search" size={18} color={colors.textMuted} style={styles.searchIcon} />
                    <TextInput
                      style={styles.searchInput}
                      value={pickerQuery}
                      onChangeText={setPickerQuery}
                      placeholder="Search languages"
                      placeholderTextColor={colors.textMuted}
                      autoCorrect={false}
                      autoCapitalize="none"
                      returnKeyType="done"
                      onSubmitEditing={() => Keyboard.dismiss()}
                    />
                    {pickerQuery.length > 0 ? (
                      <Pressable
                        onPress={() => setPickerQuery('')}
                        hitSlop={10}
                        accessibilityRole="button"
                        accessibilityLabel="Clear search"
                      >
                        <Ionicons name="close-circle" size={20} color={colors.textMuted} />
                      </Pressable>
                    ) : null}
                  </View>

                  <FlatList
                    ref={pickerListRef}
                    data={filteredPickerLanguages}
                    keyExtractor={(item) => item.code}
                    keyboardShouldPersistTaps="handled"
                    keyboardDismissMode="on-drag"
                    style={styles.modalList}
                    renderItem={({ item }) => {
                      const selectedCode =
                        pickerSlot === 'left'
                          ? languageLeft.trim().toLowerCase()
                          : languageRight.trim().toLowerCase();
                      const isSelected = item.code === selectedCode;
                      return (
                        <Pressable
                          style={[styles.modalRow, isSelected && styles.modalRowSelected]}
                          onPress={() => pickerSlot && pickLanguage(pickerSlot, item.code)}
                          accessibilityRole="button"
                          accessibilityState={{ selected: isSelected }}
                        >
                          <Text
                            style={[styles.modalRowLabel, isSelected && styles.modalRowLabelSelected]}
                            numberOfLines={2}
                          >
                            {item.label}
                          </Text>
                          {isSelected ? (
                            <Ionicons name="checkmark-circle" size={22} color={colors.primary} />
                          ) : null}
                        </Pressable>
                      );
                    }}
                    ListEmptyComponent={
                      <Text style={styles.modalEmpty}>{`No languages match "${pickerQuery.trim()}".`}</Text>
                    }
                  />
                </View>
              </View>
            </KeyboardAvoidingView>
          </SafeAreaView>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  banner: {
    marginHorizontal: spacing.md,
    marginTop: spacing.sm,
    color: colors.danger,
    fontSize: 14,
  },
  body: { flex: 1 },
  bodyCenter: { flex: 1, justifyContent: 'center' },
  hero: {
    alignItems: 'center',
    paddingHorizontal: spacing.xl,
    gap: spacing.sm,
    maxWidth: 420,
    alignSelf: 'center',
  },
  heroTitle: {
    fontSize: 34,
    fontWeight: '700',
    letterSpacing: -0.8,
    color: colors.primary,
    textAlign: 'center',
  },
  heroSubtitle: {
    fontSize: 17,
    lineHeight: 24,
    fontWeight: '400',
    color: colors.textSecondary,
    textAlign: 'center',
  },
  listening: {
    fontSize: 34,
    fontWeight: '700',
    letterSpacing: -0.8,
    color: colors.primary,
    textAlign: 'center',
  },
  listeningHint: {
    marginTop: spacing.sm,
    fontSize: 15,
    lineHeight: 22,
    color: colors.textSecondary,
    textAlign: 'center',
    paddingHorizontal: spacing.lg,
  },
  listeningInScroll: {
    minHeight: WINDOW_HEIGHT * 0.42,
    justifyContent: 'center',
    alignItems: 'center',
  },
  transcriptScroll: { flex: 1 },
  transcriptScrollContent: {
    paddingHorizontal: spacing.sm,
    paddingTop: spacing.xs,
    paddingBottom: spacing.lg,
    flexGrow: 1,
  },
  transcriptCard: {
    marginBottom: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.background,
  },
  translationPrimary: {
    fontSize: 26,
    lineHeight: 34,
    fontWeight: '700',
    color: colors.text,
    letterSpacing: -0.35,
  },
  /**
   * Three-dot bouncing indicator that occupies the same vertical slot as `translationPrimary` (lineHeight 34)
   * so the live card height is stable whether translation text or the indicator is rendering.
   */
  translatingPulseRow: {
    height: 34,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  translatingDot: {
    width: 9,
    height: 9,
    borderRadius: 5,
    backgroundColor: colors.text,
  },
  /** Breathing room between the small source line (top) and the large translation block (below). */
  transcriptDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
    marginTop: spacing.sm,
    marginBottom: spacing.sm,
    alignSelf: 'stretch',
    opacity: 0.85,
  },
  originalSecondary: {
    fontSize: 16,
    lineHeight: 24,
    color: colors.textSecondary,
    fontWeight: '400',
  },
  dock: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.background,
    paddingTop: spacing.lg,
    alignItems: 'center',
    gap: spacing.md,
  },
  langRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    width: '100%',
  },
  langPill: {
    flex: 1,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
  },
  langPillText: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.text,
    width: '100%',
    textAlign: 'center',
  },
  swapBtn: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 22,
  },
  micFab: {
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 3,
    borderColor: colors.primaryRing,
    marginBottom: spacing.sm,
  },
  micFabActive: {
    backgroundColor: '#7A8F00',
    borderColor: '#6B7F00',
  },
  modalOuter: {
    flex: 1,
  },
  modalSafeTop: {
    flex: 1,
  },
  modalKbRoot: {
    flex: 1,
  },
  modalRoot: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  modalBackdropFill: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(15, 23, 42, 0.45)',
  },
  modalSheet: {
    backgroundColor: colors.background,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingTop: spacing.md,
    paddingHorizontal: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    width: '100%',
    flexShrink: 1,
  },
  modalTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: colors.text,
    marginBottom: spacing.sm,
  },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingHorizontal: spacing.sm,
    marginBottom: spacing.sm,
    minHeight: 44,
    backgroundColor: colors.background,
  },
  searchIcon: { marginRight: spacing.xs },
  searchInput: {
    flex: 1,
    fontSize: 16,
    color: colors.text,
    paddingVertical: Platform.OS === 'ios' ? 10 : 8,
    paddingHorizontal: spacing.xs,
  },
  modalList: { flex: 1 },
  modalEmpty: {
    paddingVertical: spacing.lg,
    textAlign: 'center',
    color: colors.textMuted,
    fontSize: 15,
  },
  modalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  modalRowSelected: {
    backgroundColor: 'rgba(37, 99, 235, 0.09)',
    borderRadius: 10,
    marginHorizontal: -spacing.xs,
    paddingHorizontal: spacing.sm + spacing.xs,
    borderBottomColor: 'transparent',
  },
  modalRowLabel: { flex: 1, fontSize: 16, color: colors.text },
  modalRowLabelSelected: {
    color: colors.primary,
    fontWeight: '700',
  },
});
