import React, { useRef } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { X } from 'lucide-react-native';
import { colors, radii, spacing } from '../theme';

/**
 * Full-screen camera that reads one QR code (UI-SPEC Amendment D: the PC shows the
 * pairing QR at http://127.0.0.1:8787/pair, the phone scans it).
 */
export function QrScanner(props: { visible: boolean; onScan: (data: string) => void; onClose: () => void }) {
  const [permission, requestPermission] = useCameraPermissions();
  const handled = useRef(false);

  return (
    <Modal
      visible={props.visible}
      animationType="slide"
      onRequestClose={props.onClose}
      onShow={() => {
        handled.current = false;
        if (!permission?.granted) void requestPermission();
      }}
    >
      <View style={styles.root}>
        {permission?.granted ? (
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={({ data }) => {
              if (handled.current) return;
              handled.current = true;
              props.onScan(data);
            }}
          />
        ) : (
          <View style={styles.center}>
            <Text style={styles.text}>
              {permission?.canAskAgain === false
                ? 'Camera is blocked for this app. Allow it in Android settings, or enter the code instead.'
                : 'Allow the camera to scan the pairing QR shown on your PC.'}
            </Text>
            {permission?.canAskAgain !== false ? (
              <Pressable style={styles.btn} onPress={() => void requestPermission()}>
                <Text style={styles.btnText}>Allow camera</Text>
              </Pressable>
            ) : null}
          </View>
        )}
        <View style={styles.frame} pointerEvents="none" />
        <Text style={styles.hint}>Point at the QR on your PC (127.0.0.1:8787/pair)</Text>
        <Pressable style={styles.close} onPress={props.onClose} accessibilityLabel="Close scanner" hitSlop={10}>
          <X size={28} color="#fff" />
        </Pressable>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' },
  center: { padding: spacing.lg, alignItems: 'center', gap: spacing.md },
  text: { color: '#fff', fontSize: 16, textAlign: 'center' },
  btn: { backgroundColor: colors.accent, borderRadius: radii.pill, paddingHorizontal: spacing.lg, minHeight: 48, justifyContent: 'center' },
  btnText: { color: colors.accentText, fontWeight: '700' },
  frame: { position: 'absolute', width: 240, height: 240, borderWidth: 3, borderColor: '#fff', borderRadius: 16 },
  hint: { position: 'absolute', bottom: 96, color: '#fff', fontSize: 14, paddingHorizontal: spacing.lg, textAlign: 'center' },
  close: { position: 'absolute', top: 48, right: 24 },
});
