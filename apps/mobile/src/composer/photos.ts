import * as ImagePicker from 'expo-image-picker';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import type { PhonePhoto } from '../hub/types';

/** Long edge cap: keeps a phone photo around a few hundred KB over Tailscale. */
const MAX_EDGE = 1600;

/**
 * Take a photo with the camera or pick one from the gallery, shrink it, and return it as
 * base64 JPEG for the Hub to paste into the Cursor chat. Null when cancelled / denied.
 */
export async function pickPhoto(source: 'camera' | 'library'): Promise<PhonePhoto | null> {
  const permission =
    source === 'camera'
      ? await ImagePicker.requestCameraPermissionsAsync()
      : await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) return null;

  const options: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: 1 };
  const result =
    source === 'camera'
      ? await ImagePicker.launchCameraAsync(options)
      : await ImagePicker.launchImageLibraryAsync(options);
  const asset = result.canceled ? null : result.assets[0];
  if (!asset) return null;

  const context = ImageManipulator.manipulate(asset.uri);
  if (Math.max(asset.width, asset.height) > MAX_EDGE) {
    context.resize(asset.width >= asset.height ? { width: MAX_EDGE } : { height: MAX_EDGE });
  }
  const image = await context.renderAsync();
  const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: 0.7, base64: true });
  if (!saved.base64) return null;
  return {
    name: `phone-photo-${Date.now()}.jpg`,
    mime: 'image/jpeg',
    base64: saved.base64,
  };
}
