// The Huya web gateway uses Tars for both room-group messages and WUP tokens.
export type TarsValue = number | bigint | string | Buffer | TarsFields | TarsValue[] | Map<TarsValue, TarsValue>;
export type TarsFields = Map<number, TarsValue>;

const Type = {
  Byte: 0, Short: 1, Int: 2, Long: 3, Float: 4, Double: 5, String1: 6, String4: 7,
  Map: 8, List: 9, Struct: 10, End: 11, Zero: 12, Bytes: 13,
} as const;

function head(type: number, tag: number): Buffer {
  return tag < 15 ? Buffer.from([(tag << 4) | type]) : Buffer.from([0xf0 | type, tag]);
}

export function tarsInt(tag: number, value: number | bigint): Buffer {
  if (value === 0 || value === 0n) return head(Type.Zero, tag);
  const size = value >= -128 && value <= 127 ? 1 : value >= -32768 && value <= 32767 ? 2 :
    value >= -2147483648 && value <= 2147483647 ? 4 : 8;
  const body = Buffer.allocUnsafe(size);
  if (size === 8) body.writeBigInt64BE(BigInt(value));
  else body.writeIntBE(Number(value), 0, size);
  return Buffer.concat([head(Math.log2(size), tag), body]);
}

export function tarsString(tag: number, value: string): Buffer {
  const body = Buffer.from(value);
  if (body.length <= 255) return Buffer.concat([head(Type.String1, tag), Buffer.from([body.length]), body]);
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(body.length);
  return Buffer.concat([head(Type.String4, tag), length, body]);
}

export function tarsBytes(tag: number, body: Buffer): Buffer {
  return Buffer.concat([head(Type.Bytes, tag), head(Type.Byte, 0), tarsInt(0, body.length), body]);
}

export function tarsStruct(tag: number, ...fields: Buffer[]): Buffer {
  return Buffer.concat([head(Type.Struct, tag), ...fields, head(Type.End, 0)]);
}

export function tarsList(tag: number, entries: Buffer[]): Buffer {
  return Buffer.concat([head(Type.List, tag), tarsInt(0, entries.length), ...entries]);
}

export function tarsMap(tag: number, entries: [Buffer, Buffer][]): Buffer {
  return Buffer.concat([head(Type.Map, tag), tarsInt(0, entries.length), ...entries.flat()]);
}

class Reader {
  private position = 0;
  constructor(private readonly data: Buffer) {}

  private take(size: number): Buffer {
    if (size < 0 || size > this.data.length - this.position) throw new Error('无效的虎牙数据长度');
    const start = this.position;
    this.position += size;
    return this.data.subarray(start, this.position);
  }

  private header(): { type: number; tag: number } {
    const first = this.take(1)[0]!;
    return { type: first & 15, tag: first >> 4 === 15 ? this.take(1)[0]! : first >> 4 };
  }

  fields(depth = 0): TarsFields {
    if (depth > 16) throw new Error('虎牙数据嵌套过深');
    const fields: TarsFields = new Map();
    while (this.position < this.data.length) {
      const { type, tag } = this.header();
      if (type === Type.End && depth > 0) return fields;
      fields.set(tag, this.value(type, depth));
    }
    if (depth > 0) throw new Error('虎牙数据结构未结束');
    return fields;
  }

  private size(): number {
    const { tag, type } = this.header();
    if (tag !== 0 || (type > Type.Int && type !== Type.Zero)) throw new Error('无效的虎牙容器长度');
    return type === Type.Zero ? 0 : this.take(1 << type).readIntBE(0, 1 << type);
  }

  private next(depth: number): TarsValue {
    return this.value(this.header().type, depth);
  }

  private value(type: number, depth: number): TarsValue {
    if (depth > 16) throw new Error('虎牙数据嵌套过深');
    switch (type) {
      case Type.Zero: return 0;
      case Type.Byte: return this.take(1).readInt8();
      case Type.Short: return this.take(2).readInt16BE();
      case Type.Int: return this.take(4).readInt32BE();
      case Type.Long: {
        const value = this.take(8).readBigInt64BE();
        return Number.isSafeInteger(Number(value)) ? Number(value) : value;
      }
      case Type.Float: return this.take(4).readFloatBE();
      case Type.Double: return this.take(8).readDoubleBE();
      case Type.String1: return this.take(this.take(1)[0]!).toString('utf8');
      case Type.String4: return this.take(this.take(4).readUInt32BE()).toString('utf8');
      case Type.Bytes: {
        const element = this.header();
        if (element.tag !== 0 || element.type !== Type.Byte) throw new Error('无效的虎牙字节数组');
        return this.take(this.size());
      }
      case Type.Struct: return this.fields(depth + 1);
      case Type.List:
      case Type.Map: {
        const size = this.size();
        if (size < 0 || size > 4096 || size > this.data.length - this.position) throw new Error('无效的虎牙容器长度');
        if (type === Type.List) return Array.from({ length: size }, () => this.next(depth + 1));
        const entries = new Map<TarsValue, TarsValue>();
        for (let index = 0; index < size; index++) entries.set(this.next(depth + 1), this.next(depth + 1));
        return entries;
      }
      default: throw new Error('未知的虎牙数据类型');
    }
  }
}

export function readTars(data: Buffer): TarsFields {
  return new Reader(data).fields();
}
