const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export interface CanonicalBase64UrlOptions {
  maxEncodedLength: number;
  isNonEmpty?: boolean;
  exactEncodedLength?: number;
  exactDecodedLength?: number;
}

export function encodeBase64Url(bytes: Uint8Array): string {
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const hasSecond = index + 1 < bytes.length;
    const hasThird = index + 2 < bytes.length;
    const second = hasSecond ? bytes[index + 1] : 0;
    const third = hasThird ? bytes[index + 2] : 0;
    output += BASE64URL_ALPHABET[first >> 2];
    output += BASE64URL_ALPHABET[((first & 0x03) << 4) | (second >> 4)];
    if (hasSecond) output += BASE64URL_ALPHABET[((second & 0x0f) << 2) | (third >> 6)];
    if (hasThird) output += BASE64URL_ALPHABET[third & 0x3f];
  }
  return output;
}

export function decodeCanonicalBase64Url(
  value: string,
  options: CanonicalBase64UrlOptions,
): Uint8Array | null {
  if (value.length > options.maxEncodedLength) return null;
  if (options.isNonEmpty === true && value.length === 0) return null;
  if (options.exactEncodedLength !== undefined && value.length !== options.exactEncodedLength) {
    return null;
  }
  if (value.length % 4 === 1) return null;
  for (const character of value) {
    if (BASE64URL_ALPHABET.indexOf(character) < 0) return null;
  }

  const output: number[] = [];
  for (let index = 0; index < value.length; index += 4) {
    const remaining = value.length - index;
    if (remaining === 1) return null;
    const first = BASE64URL_ALPHABET.indexOf(value[index]);
    const second = BASE64URL_ALPHABET.indexOf(value[index + 1]);
    const third = remaining > 2 ? BASE64URL_ALPHABET.indexOf(value[index + 2]) : 0;
    const fourth = remaining > 3 ? BASE64URL_ALPHABET.indexOf(value[index + 3]) : 0;
    output.push((first << 2) | (second >> 4));
    if (remaining > 2) output.push(((second & 0x0f) << 4) | (third >> 2));
    if (remaining > 3) output.push(((third & 0x03) << 6) | fourth);
  }

  const bytes = new Uint8Array(output);
  if (options.exactDecodedLength !== undefined && bytes.length !== options.exactDecodedLength) {
    return null;
  }
  return encodeBase64Url(bytes) === value ? bytes : null;
}
