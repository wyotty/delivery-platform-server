import { UnifiedOrder } from '../../core/types.js';
import { GrabStatement } from './api.js';

export function normalizeOrder(
  statement: GrabStatement,
  accountId: string,
  merchantId: string,
  platformTimezone: string,
): UnifiedOrder {
  // Status mapping: cancelled is detected by cancelRole/cancelledAt, not by deliveryStatus
  const isCancelled = !!(statement.cancelRole || statement.cancelledAt);
  const status = isCancelled ? 'cancelled'
    : statement.deliveryStatus === 'COMPLETED' ? 'completed'
    : statement.deliveryStatus === 'FAILED' ? 'cancelled'
    : statement.deliveryStatus === 'ORDER_EXECUTING' ? 'in_progress'
    : 'other'; // unknown/new Grab statuses surface as 'other' (platformStatus keeps the raw value)

  const netMinor = statement.orderEarningsInMinorUnit ?? 0;
  const currency = statement.currency?.code ?? 'VND';

  return {
    platform: 'grab',
    platformOrderId: statement.ID || statement.bookingCode,
    accountId,
    merchantId,
    status,
    platformStatus: statement.deliveryStatus,
    // grossAmountMinor is null for Grab — it only provides net earnings
    grossAmountMinor: null,
    netAmountMinor: netMinor,
    currency,
    orderedAt: statement.createdAt,
    platformTimezone,
    rawJson: statement,
    updatedAt: statement.updatedAt,
  };
}
