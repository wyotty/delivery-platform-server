# UnifiedOrder -> @posx/core Invoice mapping

`mapUnifiedOrderToInvoice(order, options?)` in `src/mappers/xpos-invoice.ts`
maps a [`UnifiedOrder`](../src/core/types.ts) (this repo's normalized order
model, produced by platform adapters like `src/platforms/grab/normalize.ts`)
to an `Invoice` from the [`@posx/core`](https://www.npmjs.com/package/@posx/core)
POS package.

Pipeline: raw Grab statement → `normalizeOrder()` → `UnifiedOrder` →
`mapUnifiedOrderToInvoice()` → `Invoice`.

## Field mapping (Grab -> UnifiedOrder -> Invoice)

| Grab statement field | UnifiedOrder field | Invoice field |
|---|---|---|
| — (fixed `"grab"`) | `platform` | `delivery_type`, `meta.platform` |
| `ID` (fallback `bookingCode`) | `platformOrderId` | `ref_id`, `meta.platform_order_id` |
| — (aggregator account) | `accountId` | `meta.account_id` |
| — (fixed per merchant) | `merchantId` | `meta.merchant_id` |
| `deliveryStatus` (+ `cancelRole`/`cancelledAt`) | `status` | `status`, `paid_at`/`voided_at` (see below) |
| `deliveryStatus` | `platformStatus` | `meta.platform_status` |
| — (Grab reports net only) | `grossAmountMinor` (null) | `subtotal` (falls back to net when null) |
| `orderEarningsInMinorUnit` | `netAmountMinor` | `grand_total` |
| `currency.code` | `currency` | used for minor->major conversion only |
| `createdAt` | `orderedAt` | `created_at`, `created_at_timestamp` |
| `updatedAt` | `updatedAt` | `updated_at` |
| full statement object | `rawJson` | `meta.raw` |

Fixed values: `type` = `InvoiceType.Delivery`; `action` =
`InvoiceAction.SettleOnlineDeliveryOrder` (the @posx/core action for settling
online delivery orders).

## Status mapping

| UnifiedOrder status | Grab `deliveryStatus` | Invoice status | Timestamp side-effect |
|---|---|---|---|
| `completed` | `COMPLETED` | `InvoiceStatus.Paid` | `paid_at` = `updatedAt` |
| `cancelled` | `FAILED` / `cancelRole`/`cancelledAt` set | `InvoiceStatus.Void` | `voided_at` = `updatedAt` |
| `refunded` | — | `InvoiceStatus.Void` | `voided_at` = `updatedAt` |
| `in_progress` | `ORDER_EXECUTING` | `InvoiceStatus.Open` | — |
| `other` | anything else | `InvoiceStatus.Open` | — |

## Money-unit rules

- UnifiedOrder amounts are **minor units** (e.g. cents; whole dong for VND).
- Invoice amounts are **major decimal units** (2 dp), the convention used
  throughout @posx/core (`preciseRound(x, 2)` in its `InvoiceService`).
- Conversion: `major = minor / 10^exponent`, rounded to `max(2, exponent)` dp
  (so 3-exponent currencies keep full precision).
  Exponent lookup: `VND=0`, `JPY=0`, default `2`; override per currency via
  `options.currencyExponents` (e.g. `{ BHD: 3 }`).
- `grossAmountMinor` -> `subtotal` (also the synthetic line's price/subtotal).
  `null` gross means the platform did not provide it; net is used instead.
- `netAmountMinor` -> `grand_total`. Any gross/net gap (platform commission)
  is recorded as a flat `InvoiceDiscount` in `invoice.discounts` and mirrored
  in `discount_amount`, so `subtotal - discount_amount = grand_total` stays
  consistent even after @posx/core's `InvoiceService.calculate()` (which
  resets `discount_amount` and rederives it from `discounts`).
- One synthetic `InvoiceLine` (qty 1) carries the subtotal — platforms provide
  no line items.

## Worked example (real sample order)

Grab statement `00135171741-C8CAA8ECSFUTEA` (from
[`data/sample-orders-for-mapping.json`](../data/sample-orders-for-mapping.json)):

```json
{
  "ID": "00135171741-C8CAA8ECSFUTEA",
  "currency": { "code": "VND", "exponent": "0" },
  "orderEarningsInMinorUnit": 52000,
  "deliveryStatus": "COMPLETED",
  "createdAt": "2026-07-14T05:44:51Z",
  "updatedAt": "2026-07-14T06:05:12.688772Z"
}
```

UnifiedOrder (via `normalizeOrder`): `platform="grab"`,
`platformOrderId="00135171741-C8CAA8ECSFUTEA"`, `status="completed"`,
`grossAmountMinor=null`, `netAmountMinor=52000`, `currency="VND"`.

Resulting Invoice:

| Field | Value | Why |
|---|---|---|
| `type` | `delivery` | fixed |
| `action` | `settle_online_delivery_order` | fixed |
| `ref_id` | `00135171741-C8CAA8ECSFUTEA` | platformOrderId |
| `delivery_type` | `grab` | platform |
| `status` | `paid` | completed |
| `paid_at` | `2026-07-14T06:05:12.688Z` | updatedAt |
| `subtotal` | `52000` | net fallback (gross null), VND exponent 0: 52000 / 10^0 |
| `grand_total` | `52000` | net, 52000 / 10^0 |
| `discount_amount` | `0` | gross == net |
| `lines[0]` | qty 1, price 52000, subtotal 52000 | synthetic line |
| `created_at` | `2026-07-14T05:44:51Z` | orderedAt |
| `updated_at` | `2026-07-14T06:05:12.688Z` | updatedAt |
| `meta` | platform, platform_order_id, account_id, merchant_id, platform_status, raw | provenance |
