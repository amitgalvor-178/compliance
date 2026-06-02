/**
 * SEBI compliance rule definitions derived from:
 *  - SEBI PR No. 14/2025 (March 21, 2025) — Advisory on social media fraud
 *  - SEBI Circular HO/(79)2026-MIRSD-PODMMC (Feb 26, 2026) — EoDI registration disclosure
 *    (effective May 1, 2026)
 */

import { SEBIRuleId, type Severity } from '../../types/index.js';

export interface SEBIRule {
  id: SEBIRuleId;
  name: string;
  description: string;
  severity: Severity;
  source: string;
  llmGuidance: string;
}

export const SEBI_RULES: SEBIRule[] = [
  {
    id: SEBIRuleId.UNREG_INVESTMENT_ADVICE,
    name: 'Unregistered Investment Advice',
    description:
      'Providing specific buy/sell recommendations on individual stocks, mutual funds, or other securities without a SEBI Research Analyst (INH) or Investment Adviser (INA) registration.',
    severity: 'critical',
    source: 'SEBI PR No. 14/2025',
    llmGuidance: `Flag content that:
- Recommends buying or selling specific named securities, stocks, or mutual fund schemes
- Uses phrases like "buy this stock", "strong buy", "this will 10x", "multibagger pick", "target price ₹X"
- Gives portfolio advice or asset allocation guidance
Do NOT flag: general financial education, market commentary without specific stock calls, discussions of past market events.`,
  },
  {
    id: SEBIRuleId.GUARANTEED_RETURNS,
    name: 'Guaranteed / Assured Returns Claims',
    description:
      'Claiming risk-free, guaranteed, assured, or fixed returns on securities market investments.',
    severity: 'critical',
    source: 'SEBI PR No. 14/2025',
    llmGuidance: `Flag content that:
- Promises guaranteed profit, assured returns, risk-free investments, fixed returns, double your money
- Uses phrases like "100% returns", "no loss strategy", "guaranteed income from stock market"
- Implies that losses are impossible or returns are certain
Do NOT flag: Fixed Deposit or debt fund discussions where returns are contractually guaranteed by the product itself.`,
  },
  {
    id: SEBIRuleId.MISSING_REG_DISCLOSURE,
    name: 'Missing SEBI Registration Disclosure',
    description:
      'SEBI regulated entities and their agents must display their registered name and SEBI registration number on their social media profile and at the beginning of securities-related video content (SEBI Circular HO/79/2026, effective May 1, 2026).',
    severity: 'high',
    source: 'SEBI Circular HO/(79)2026-MIRSD-PODMMC',
    llmGuidance: `This rule is evaluated at the bio/transcript level, not per-post by LLM. LLM should flag:
- Content that relates to the securities market (stocks, mutual funds, trading, investing) without any mention of SEBI registration at the start.
Known SEBI registration prefixes: INH (Research Analyst), INA (Investment Adviser), INZ (Stock Broker), ARN- (MF Distributor).`,
  },
  {
    id: SEBIRuleId.UNDISCLOSED_PAID_PROMO,
    name: 'Undisclosed Paid Promotion',
    description:
      'Promoting securities products (broker apps, demat accounts, trading platforms, mutual fund products) without clearly disclosing the commercial relationship.',
    severity: 'high',
    source: 'SEBI PR No. 14/2025',
    llmGuidance: `Flag content that:
- Promotes a broker, demat account, trading app, mutual fund, or insurance product
- Does NOT include explicit disclosure keywords: #ad, #sponsored, #paidpartnership, #collab, #gifted, "paid promotion", "in association with", "sponsored by"
Do NOT flag: Organic mentions or reviews that are clearly not promotional in tone.`,
  },
  {
    id: SEBIRuleId.FRAUDULENT_COURSE,
    name: 'Fraudulent Trading Course / Seminar',
    description:
      'Promoting paid trading courses, seminars, or investment programs that claim to teach guaranteed or high-return strategies.',
    severity: 'critical',
    source: 'SEBI PR No. 14/2025',
    llmGuidance: `Flag content that:
- Advertises paid trading courses, masterclasses, bootcamps, or seminars
- AND combines this with return claims ("learn to make ₹X/day", "earn guaranteed profits", "90% success rate")
- Charges money for signals, tips, or investment advice groups (Telegram, WhatsApp)
Do NOT flag: Free educational content, general financial literacy resources without monetary claims.`,
  },
];

// SEBI registration number patterns (INH, INA, INZ, ARN-)
export const SEBI_REGISTRATION_PATTERNS = [
  /\bINH\d{9}\b/i,
  /\bINA\d{9}\b/i,
  /\bINZ\d{9}\b/i,
  /\bARN-\d{4,6}\b/i,
  /\bSEBI\s+Reg(?:istration)?\s*(?:No\.?|Number)?\s*[:\-]?\s*[A-Z]{2,3}\d{6,12}\b/i,
];

export function extractSEBIRegistration(text: string): string | null {
  for (const pattern of SEBI_REGISTRATION_PATTERNS) {
    const match = text.match(pattern);
    if (match) return match[0];
  }
  return null;
}

// Critical rule IDs — any FAIL here forces NON_COMPLIANT verdict
export const CRITICAL_SEBI_RULE_IDS: SEBIRuleId[] = [
  SEBIRuleId.UNREG_INVESTMENT_ADVICE,
  SEBIRuleId.GUARANTEED_RETURNS,
  SEBIRuleId.FRAUDULENT_COURSE,
];
