import { Type, type Static } from '@sinclair/typebox';

import { DateTimeSchema, IdSchema, NonEmptyStringSchema } from './common.js';

export const NetworkAddressSchema = Type.Object(
  {
    address: NonEmptyStringSchema,
    prefixLength: Type.Integer({ minimum: 0, maximum: 128 }),
    family: Type.Union([Type.Literal('ipv4'), Type.Literal('ipv6')]),
    scope: Type.Optional(Type.String()),
    classification: Type.Union([
      Type.Literal('loopback'),
      Type.Literal('private'),
      Type.Literal('public'),
      Type.Literal('unknown'),
    ]),
  },
  { additionalProperties: false },
);

export const NetworkInterfaceSchema = Type.Object(
  {
    id: IdSchema,
    name: NonEmptyStringSchema,
    state: Type.Optional(Type.String()),
    macAddress: Type.Optional(Type.String()),
    mtu: Type.Optional(Type.Integer({ minimum: 0 })),
    addresses: Type.Array(NetworkAddressSchema),
    evidenceIds: Type.Array(IdSchema),
  },
  { additionalProperties: false },
);

export type NetworkInterface = Static<typeof NetworkInterfaceSchema>;

export const RouteRecordSchema = Type.Object(
  {
    destination: NonEmptyStringSchema,
    gateway: Type.Optional(Type.String()),
    device: Type.Optional(Type.String()),
    metric: Type.Optional(Type.Integer({ minimum: 0 })),
    table: Type.Optional(Type.String()),
    isDefault: Type.Boolean(),
  },
  { additionalProperties: false },
);

export type RouteRecord = Static<typeof RouteRecordSchema>;

export const DnsSnapshotSchema = Type.Object(
  {
    servers: Type.Array(NonEmptyStringSchema),
    searchDomains: Type.Array(NonEmptyStringSchema),
    source: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export type DnsSnapshot = Static<typeof DnsSnapshotSchema>;

export const FirewallSummarySchema = Type.Object(
  {
    backend: Type.Union([
      Type.Literal('nftables'),
      Type.Literal('iptables'),
      Type.Literal('firewalld'),
      Type.Literal('ufw'),
      Type.Literal('none'),
      Type.Literal('unknown'),
    ]),
    active: Type.Optional(Type.Boolean()),
    summary: Type.Array(Type.String()),
    evidenceIds: Type.Array(IdSchema),
  },
  { additionalProperties: false },
);

export type FirewallSummary = Static<typeof FirewallSummarySchema>;

export const NetworkSnapshotSchema = Type.Object(
  {
    interfaces: Type.Array(NetworkInterfaceSchema),
    routes: Type.Array(RouteRecordSchema),
    dns: DnsSnapshotSchema,
    firewall: FirewallSummarySchema,
    collectedAt: DateTimeSchema,
  },
  { additionalProperties: false },
);

export type NetworkSnapshot = Static<typeof NetworkSnapshotSchema>;
