/** Classify complete FLV tags consistently for preview bootstrap and seek indexes.
 * Enhanced RTMP uses bit 7 as ExHeader and the low nibble as packet type;
 * legacy AVC/HEVC stores packet type in the following byte. */
export function isFlvSequenceHeader(tag: Buffer, offset = 0): boolean {
  if (tag.length - offset < 16) return false;
  const size = tag.readUIntBE(offset + 1, 3);
  if (size < 1 || tag.length - offset < size + 15) return false;
  const first = tag[offset + 11]!;
  if (tag[offset] === 8)
    return size >= 2 && first >> 4 === 10 && tag[offset + 12] === 0;
  if (tag[offset] !== 9) return false;
  if (first & 0x80) return size >= 5 && (first & 0x0f) === 0;
  return size >= 2 && [7, 12].includes(first & 0x0f) && tag[offset + 12] === 0;
}

export function isFlvVideoKeyframe(tag: Buffer, offset = 0): boolean {
  if (tag.length - offset < 16 || tag[offset] !== 9) return false;
  const size = tag.readUIntBE(offset + 1, 3);
  if (size < 1 || tag.length - offset < size + 15) return false;
  const first = tag[offset + 11]!;
  if (((first >> 4) & 7) !== 1) return false;
  if (first & 0x80)
    return size >= 5 && [1, 3].includes(first & 0x0f);
  if ([7, 12].includes(first & 0x0f))
    return size >= 2 && tag[offset + 12] === 1;
  return true;
}
