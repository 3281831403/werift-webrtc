// AV1 RTP W=0 パケットを組み立てる共有 Arrange ユーティリティ。
// 上流パッカー（§4.4 の W=0: 全 OBU element が leb128 長前置）を模擬する。
import { leb128decode } from "../../src/codec/av1";
import { leb128encode } from "../../src/codec/leb128";
import { RtpHeader, RtpPacket } from "../../src/rtp/rtp";

/**
 * OBU 列（size field 有り/無し混在可）を、各 element に長さ前置する W=0 の
 * RTP パケット列に変換する。MTU を超える OBU は Z/Y ビットで跨パケット分割し、
 * パケットに空きがあれば後続の完全 OBU も同梱する（aggregation + fragmentation）。
 */
export function packetizeW0(
  sample: Buffer,
  mtu: number,
  {
    startsNewCodedVideoSequence = false,
  }: { startsNewCodedVideoSequence?: boolean } = {},
): RtpPacket[] {
  const obus: Buffer[] = [];
  {
    let offset = 0;
    while (offset < sample.length) {
      const header = sample[offset]!;
      const headerLength = 1 + ((header >> 2) & 1); // + extension byte
      let bodyLength = sample.length - offset - headerLength;
      let sizeLength = 0;
      if ((header >> 1) & 1) {
        const [size, bytes] = leb128decode(
          sample.subarray(offset + headerLength),
        );
        bodyLength = size;
        sizeLength = bytes;
      }
      const end = offset + headerLength + sizeLength + bodyLength;
      obus.push(sample.subarray(offset, end));
      offset = end;
    }
  }

  const packets: RtpPacket[] = [];
  let sequenceNumber = 1;
  let first = true;
  let obuIndex = 0;
  let obuOffset = 0;

  while (obuIndex < obus.length) {
    const startsWithFragment = !first;
    const elements: Buffer[] = [];
    let endsWithFragment = false;
    let capacity = mtu - 1; // aggregation header 1 byte

    while (obuIndex < obus.length && capacity > 0) {
      const rest = obus[obuIndex]!.subarray(obuOffset);
      const prefixLength = leb128encode(Math.min(rest.length, capacity)).length;
      const room = capacity - prefixLength;
      if (room <= 0) break;
      const take = Math.min(rest.length, room);
      elements.push(rest.subarray(0, take));
      capacity -= take + prefixLength;
      if (take < rest.length) {
        obuOffset += take;
        endsWithFragment = true;
      } else {
        obuIndex++;
        obuOffset = 0;
      }
    }

    // Z(bit7) Y(bit6) W=00(bit5-4) N(bit3)、残りは 0
    const n = startsNewCodedVideoSequence && first ? 1 << 3 : 0;
    const aggregationHeader =
      ((startsWithFragment ? 1 : 0) << 7) |
      ((endsWithFragment ? 1 : 0) << 6) |
      n;
    const body = Buffer.concat(
      elements.flatMap((element) => [leb128encode(element.length), element]),
    );
    packets.push(
      new RtpPacket(
        new RtpHeader({
          sequenceNumber: sequenceNumber++,
          timestamp: 90_000,
          marker: false,
        }),
        Buffer.concat([Buffer.from([aggregationHeader]), body]),
      ),
    );
    first = false;
  }

  packets.at(-1)!.header.marker = true;
  return packets;
}
