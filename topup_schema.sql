-- Add iccid column to conversations (needed to remember which eSIM
-- someone's checking/topping up, between messages)
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS iccid TEXT;

-- New table for top-up orders (separate from the main purchase flow,
-- since a top-up can happen long after the original purchase conversation)
CREATE TABLE IF NOT EXISTS topup_orders (
  id SERIAL PRIMARY KEY,
  sender_id TEXT NOT NULL,
  invoice_id TEXT UNIQUE NOT NULL,
  invoice_number TEXT,
  iccid TEXT NOT NULL,
  order_no TEXT NOT NULL,
  package_code TEXT NOT NULL,
  gb TEXT,
  status TEXT NOT NULL DEFAULT 'AWAITING_PAYMENT',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
