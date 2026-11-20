import { Alert, Linking, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { Screen, Button, Card, EmptyState } from '@kiwi/mobile-ui';
import { useTranslation } from '@kiwi/i18n';
import { kycApi } from '../../src/api/kyc';
import { http } from '../../src/api/client';

const api = kycApi(http);

// La verificación manual (fotos de cédula, selfie, licencia) vive en la PWA:
// un solo formulario que mantener. El botón la abre en el navegador.
const DRIVER_WEB_URL = (
  process.env.EXPO_PUBLIC_DRIVER_WEB_URL || 'https://repartidores.kiwicr.express'
).replace(/\/+$/, '');

const STATUS_LABEL: Record<
  string,
  'pending' | 'submitted' | 'underReview' | 'approved' | 'rejected'
> = {
  not_submitted: 'pending',
  pending: 'pending',
  submitted: 'submitted',
  documents_submitted: 'submitted',
  under_review: 'underReview',
  approved: 'approved',
  rejected: 'rejected',
};

export default function Kyc() {
  const { t } = useTranslation();
  const { data, isError, refetch, isRefetching } = useQuery({
    queryKey: ['kyc', 'status'],
    queryFn: () => api.status(),
  });

  const raw = String((data as any)?.status ?? 'pending').toLowerCase();
  const key = STATUS_LABEL[raw] ?? 'pending';
  const done = key === 'approved';

  const openWebForm = async () => {
    try {
      await Linking.openURL(`${DRIVER_WEB_URL}/kyc`);
    } catch {
      Alert.alert(t.kyc.loadFailed);
    }
  };

  return (
    <Screen>
      <Text className="text-xl font-bold text-surface-800 dark:text-surface-100">
        {t.kyc.title}
      </Text>
      <Text className="mt-1 text-sm text-surface-500 dark:text-surface-400">{t.kyc.subtitle}</Text>

      <View className="mt-3">
        <Card>
          {isError ? (
            <EmptyState title={t.kyc.loadFailed} />
          ) : (
            <Text className="text-base font-bold text-surface-800 dark:text-surface-100">
              {t.kyc.status}: {t.kyc[key]}
            </Text>
          )}
        </Card>
      </View>

      <View className="mt-3 gap-2">
        {!done && key !== 'submitted' && key !== 'underReview' && (
          <Button label={t.kyc.verifyNow} onPress={() => void openWebForm()} />
        )}
        <Button
          label={t.kyc.refresh}
          variant="secondary"
          loading={isRefetching}
          onPress={() => void refetch()}
        />
      </View>
    </Screen>
  );
}
