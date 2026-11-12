-- CreateEnum
CREATE TYPE "PaymentMode" AS ENUM ('FIXTURE', 'SANDBOX');
CREATE TYPE "CaseStatus" AS ENUM ('NEW', 'ANALYSIS_FAILED', 'AWAITING_REVIEW', 'ESCALATED', 'APPROVED', 'EXECUTING', 'REFUND_PENDING', 'NEEDS_RECONCILIATION', 'REFUNDED', 'REFUND_FAILED', 'DECLINED');
CREATE TYPE "ProposalAction" AS ENUM ('REFUND', 'DECLINE', 'ESCALATE');
CREATE TYPE "ProposalSource" AS ENUM ('AI', 'MERCHANT');
CREATE TYPE "RefundOpState" AS ENUM ('CREATED', 'SUBMITTED', 'PAYPAL_PENDING', 'UNKNOWN', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "Merchant" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Merchant_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Policy" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    CONSTRAINT "Policy_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "customerEmail" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "shippingCents" INTEGER NOT NULL,
    "totalCents" INTEGER NOT NULL,
    "placedAt" TIMESTAMP(3) NOT NULL,
    "deliveredAt" TIMESTAMP(3),
    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LineItem" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unitCents" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    CONSTRAINT "LineItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PaymentLink" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "captureId" TEXT NOT NULL,
    "mode" "PaymentMode" NOT NULL,
    "currency" TEXT NOT NULL,
    "capturedCents" INTEGER NOT NULL,
    "captureStatus" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3) NOT NULL,
    "raw" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PaymentLink_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SandboxCheckout" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "paypalOrderId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "captureId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SandboxCheckout_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Case" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "label" TEXT,
    "complaint" TEXT NOT NULL,
    "status" "CaseStatus" NOT NULL DEFAULT 'NEW',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Case_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Analysis" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "raw" JSONB,
    "parsed" JSONB,
    "valid" BOOLEAN NOT NULL,
    "errors" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Analysis_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Proposal" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "analysisId" TEXT,
    "source" "ProposalSource" NOT NULL,
    "action" "ProposalAction" NOT NULL,
    "items" JSONB NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "captureId" TEXT,
    "reasons" JSONB NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "supersededAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Proposal_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Approval" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "proposalVersion" INTEGER NOT NULL,
    "captureId" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "approvedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "invalidatedAt" TIMESTAMP(3),
    "invalidReason" TEXT,
    CONSTRAINT "Approval_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RefundOperation" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "approvalId" TEXT NOT NULL,
    "mode" "PaymentMode" NOT NULL,
    "captureId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "paypalRequestId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "activeLock" TEXT,
    "state" "RefundOpState" NOT NULL DEFAULT 'CREATED',
    "paypalRefundId" TEXT,
    "paypalStatus" TEXT,
    "lastError" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RefundOperation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "paypalEventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL,
    "source" TEXT NOT NULL,
    "resourceId" TEXT,
    "payload" JSONB NOT NULL,
    "outcome" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "caseId" TEXT,
    "type" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FixtureCapture" (
    "id" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FixtureCapture_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FixtureRefund" (
    "id" TEXT NOT NULL,
    "captureId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FixtureRefund_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Policy_merchantId_key_key" ON "Policy"("merchantId", "key");
CREATE UNIQUE INDEX "Order_orderNumber_key" ON "Order"("orderNumber");
CREATE UNIQUE INDEX "PaymentLink_orderId_key" ON "PaymentLink"("orderId");
CREATE UNIQUE INDEX "PaymentLink_captureId_key" ON "PaymentLink"("captureId");
CREATE UNIQUE INDEX "SandboxCheckout_paypalOrderId_key" ON "SandboxCheckout"("paypalOrderId");
CREATE UNIQUE INDEX "Proposal_caseId_version_key" ON "Proposal"("caseId", "version");
CREATE UNIQUE INDEX "RefundOperation_approvalId_key" ON "RefundOperation"("approvalId");
CREATE UNIQUE INDEX "RefundOperation_paypalRequestId_key" ON "RefundOperation"("paypalRequestId");
CREATE UNIQUE INDEX "RefundOperation_invoiceId_key" ON "RefundOperation"("invoiceId");
CREATE UNIQUE INDEX "RefundOperation_activeLock_key" ON "RefundOperation"("activeLock");
CREATE UNIQUE INDEX "RefundOperation_paypalRefundId_key" ON "RefundOperation"("paypalRefundId");
CREATE UNIQUE INDEX "WebhookEvent_paypalEventId_key" ON "WebhookEvent"("paypalEventId");
CREATE INDEX "AuditEvent_caseId_createdAt_idx" ON "AuditEvent"("caseId", "createdAt");
CREATE UNIQUE INDEX "FixtureRefund_requestId_key" ON "FixtureRefund"("requestId");

-- AddForeignKey
ALTER TABLE "Policy" ADD CONSTRAINT "Policy_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Order" ADD CONSTRAINT "Order_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LineItem" ADD CONSTRAINT "LineItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentLink" ADD CONSTRAINT "PaymentLink_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SandboxCheckout" ADD CONSTRAINT "SandboxCheckout_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Case" ADD CONSTRAINT "Case_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Case" ADD CONSTRAINT "Case_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Analysis" ADD CONSTRAINT "Analysis_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Proposal" ADD CONSTRAINT "Proposal_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Proposal" ADD CONSTRAINT "Proposal_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "Analysis"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "Proposal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RefundOperation" ADD CONSTRAINT "RefundOperation_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RefundOperation" ADD CONSTRAINT "RefundOperation_approvalId_fkey" FOREIGN KEY ("approvalId") REFERENCES "Approval"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "FixtureRefund" ADD CONSTRAINT "FixtureRefund_captureId_fkey" FOREIGN KEY ("captureId") REFERENCES "FixtureCapture"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
