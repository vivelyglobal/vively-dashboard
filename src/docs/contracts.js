import { TODAY, iso } from '../lib/dates.js';
import { nf } from '../lib/format.js';
import { $ } from '../ui/dom.js';

/* ============================================================
   CONTRACTS
   Three documents built from the ScoutLab / Vively templates:
     msa   — Master Service Agreement (long form)
     sow   — Statement of Work (sits under an MSA)
     short — Short-form single-project agreement (약식)

   Only the client company name is required. Everything else has
   a default lifted from the signed template and can be changed —
   fee, billing cycle, payment days, interest, notice periods.
   Each document renders in English or Korean from the same fields.
   ============================================================ */

export const CONTRACT_DEFAULTS_KEY = 'vively-contract-defaults-v1';

export const BILLING_PRESETS = {
  '50_50':      { en: '50% upon execution of this agreement; the remaining 50% upon campaign completion and delivery of the results report.',
                  ko: '총 용역비의 50%는 계약 체결 시, 나머지 50%는 캠페인 종료 및 결과 보고서 제출 후 지급한다.' },
  'advance':    { en: '100% of the Service Fee is payable in advance, before the campaign start date.',
                  ko: '총 용역비 전액을 캠페인 개시일 전에 선지급한다.' },
  'completion': { en: '100% of the Service Fee is payable upon campaign completion and delivery of the results report.',
                  ko: '총 용역비 전액을 캠페인 종료 및 결과 보고서 제출 후 지급한다.' },
  '30_40_30':   { en: '30% upon execution, 40% at the midpoint of the campaign period, and the remaining 30% upon completion.',
                  ko: '계약 체결 시 30%, 캠페인 기간의 중간 시점에 40%, 종료 시 나머지 30%를 지급한다.' },
  'monthly':    { en: 'Billed monthly in arrears. The Agency issues a tax invoice at the end of each calendar month for the Services performed in that month.',
                  ko: '매월 후불로 청구한다. 에이전시는 매월 말일에 해당 월에 수행한 용역에 대하여 세금계산서를 발행한다.' },
  'milestone':  { en: 'Billed by milestone as set out in the schedule above. A tax invoice is issued upon completion of each milestone.',
                  ko: '위 일정에 기재된 마일스톤 단위로 청구하며, 각 마일스톤 완료 시 세금계산서를 발행한다.' },
  'custom':     { en: '', ko: '' }
};
export const BILLING_LABELS = {
  '50_50': '50% on signing / 50% on completion',
  'advance': '100% in advance',
  'completion': '100% on completion',
  '30_40_30': '30% / 40% / 30%',
  'monthly': 'Monthly retainer (in arrears)',
  'milestone': 'By milestone',
  'custom': 'Custom wording…'
};

export function contractDefaults() {
  return {
    lang: 'en',
    clientName: '', clientReg: '', clientAddress: '', clientRep: '', clientContact: '', clientPhone: '',
    agencyName: 'ScoutLab', agencyReg: '', agencyAddress: '', agencyRep: '', agencyContact: '', agencyPhone: '',
    effectiveDate: iso(TODAY),
    masterDate: '',
    campaignName: '', campaignPurpose: '', platforms: '', periodStart: '', periodEnd: '', milestones: '',
    currency: 'KRW', fee: '',
    billing: '50_50', billingCustom: '',
    netDays: 30, lateInterest: 6,
    cancelFee: 50, cancelWindowDays: 7,
    reviewDays: 3, revisionRounds: 1,
    nonCircMonths: 12, nonCircPenalty: 20,
    confidentialityYears: 3, termYears: 1, cureDays: 14, forceMajeureDays: 30,
    governingLaw: 'Republic of Korea', jurisdiction: 'Seoul Central District Court',
    masterLanguage: 'en',
    notes: '',
    deliverables: [{ service: '', platform: '', qty: '', deadline: '' }],
    clauses: {
      portfolio: true, language: true, cancellationFee: true, reviewProcess: true,
      indemnity: true, nonCircumvention: true, forceMajeure: true, terminationEffect: true, esign: true
    }
  };
}

export let CONTRACT = contractDefaults();

export function loadContractDefaults() {
  try {
    const raw = localStorage.getItem(CONTRACT_DEFAULTS_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    ['agencyName','agencyReg','agencyAddress','agencyRep','agencyContact','agencyPhone',
     'governingLaw','jurisdiction','currency','netDays','lateInterest','masterLanguage','lang']
      .forEach((k) => { if (saved[k] != null && saved[k] !== '') CONTRACT[k] = saved[k]; });
  } catch (e) { /* first run */ }
}
export function saveContractDefaults() {
  try {
    localStorage.setItem(CONTRACT_DEFAULTS_KEY, JSON.stringify({
      agencyName: CONTRACT.agencyName, agencyReg: CONTRACT.agencyReg, agencyAddress: CONTRACT.agencyAddress,
      agencyRep: CONTRACT.agencyRep, agencyContact: CONTRACT.agencyContact, agencyPhone: CONTRACT.agencyPhone,
      governingLaw: CONTRACT.governingLaw, jurisdiction: CONTRACT.jurisdiction, currency: CONTRACT.currency,
      netDays: CONTRACT.netDays, lateInterest: CONTRACT.lateInterest, masterLanguage: CONTRACT.masterLanguage,
      lang: CONTRACT.lang
    }));
  } catch (e) { /* storage blocked */ }
}

/* ------------------------------ helpers ------------------------------ */
export const blank = (n) => '_'.repeat(n || 20);
export const fv = (v, n) => (v == null || String(v).trim() === '' ? blank(n) : String(v).trim());

export function contractDate(isoStr, L) {
  if (!isoStr) return L === 'ko' ? '____년 __월 __일' : '____ Year __ Month __ Day';
  const d = new Date(isoStr + 'T00:00:00Z');
  if (isNaN(d)) return isoStr;
  if (L === 'ko') return `${d.getUTCFullYear()}년 ${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일`;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}
export function contractMoney(f, L) {
  const sym = f.currency === 'USD' ? '$' : '₩';
  if (!f.fee || isNaN(Number(String(f.fee).replace(/,/g, '')))) return `${sym} ${blank(16)}`;
  return `${sym} ${nf.format(Math.round(Number(String(f.fee).replace(/,/g, ''))))}`;
}
export function billingText(f, L) {
  if (f.billing === 'custom') return f.billingCustom || (L === 'ko' ? '(별도 협의)' : '(to be agreed separately)');
  return BILLING_PRESETS[f.billing][L] || BILLING_PRESETS['50_50'][L];
}
export const P = (text, opt) => Object.assign({ t: 'p', text }, opt || {});
export const H2 = (text) => ({ t: 'h2', text });

/* ------------------------------ party blocks ------------------------------ */
export function partyTable(f, L) {
  const client = L === 'ko'
    ? `상호: ${fv(f.clientName, 18)}    사업자등록번호: ${fv(f.clientReg, 14)}\n주소: ${fv(f.clientAddress, 34)}\n대표자: ${fv(f.clientRep, 12)}    담당자/연락처: ${fv(f.clientContact, 12)}${f.clientPhone ? ' / ' + f.clientPhone : ''}`
    : `Company Name: ${fv(f.clientName, 18)}    Business Reg. No.: ${fv(f.clientReg, 14)}\nAddress: ${fv(f.clientAddress, 34)}\nRepresentative: ${fv(f.clientRep, 12)}    Contact: ${fv(f.clientContact, 12)}${f.clientPhone ? ' / ' + f.clientPhone : ''}`;
  const agency = L === 'ko'
    ? `상호: ${fv(f.agencyName, 18)}    사업자등록번호: ${fv(f.agencyReg, 14)}\n주소: ${fv(f.agencyAddress, 34)}\n대표자: ${fv(f.agencyRep, 12)}    담당자/연락처: ${fv(f.agencyContact, 12)}${f.agencyPhone ? ' / ' + f.agencyPhone : ''}`
    : `Company Name: ${fv(f.agencyName, 18)}    Business Reg. No.: ${fv(f.agencyReg, 14)}\nAddress: ${fv(f.agencyAddress, 34)}\nRepresentative: ${fv(f.agencyRep, 12)}    Contact: ${fv(f.agencyContact, 12)}${f.agencyPhone ? ' / ' + f.agencyPhone : ''}`;
  return {
    t: 'table', widths: [1900, 7400],
    rows: [
      [L === 'ko' ? '고객사 ("고객사")' : 'Client ("Client")', client],
      [L === 'ko' ? '에이전시 ("에이전시")' : 'Agency ("Agency")', agency]
    ]
  };
}

export function signatureTable(f, L) {
  const c = L === 'ko'
    ? `고객사\n회사명: ${fv(f.clientName, 20)}\n대표자: ${fv(f.clientRep, 12)} (인)\n날짜: ${contractDate('', 'ko')}`
    : `Client\nCompany Name: ${fv(f.clientName, 20)}\nRepresentative: ${fv(f.clientRep, 12)} (Seal)\nDate: ${contractDate('', 'en')}`;
  const a = L === 'ko'
    ? `에이전시 (${fv(f.agencyName, 8)})\n회사명: ${fv(f.agencyName, 20)}\n대표자: ${fv(f.agencyRep, 12)} (인)\n날짜: ${contractDate('', 'ko')}`
    : `Agency (${fv(f.agencyName, 8)})\nCompany Name: ${fv(f.agencyName, 20)}\nRepresentative: ${fv(f.agencyRep, 12)} (Seal)\nDate: ${contractDate('', 'en')}`;
  return { t: 'table', widths: [4650, 4650], rows: [[c, a]] };
}

/* ============================ 1. MASTER SERVICE AGREEMENT ============================ */
export function buildMSA(f, L) {
  const client = fv(f.clientName, 16);
  const agency = fv(f.agencyName, 10);
  const b = [];
  const ko = L === 'ko';

  b.push({ t: 'h1', text: ko ? '기본 용역 계약서 (MASTER SERVICE AGREEMENT)' : 'MASTER SERVICE AGREEMENT' });
  b.push(P(ko
    ? `본 기본 용역 계약서(이하 "본 계약")는 ${contractDate(f.effectiveDate, L)}("계약효력발생일")에 아래에 기재된 "고객사"와 "에이전시"(이하 개별적으로 "당사자", 총칭하여 "양 당사자") 간에 체결된다.`
    : `This Master Service Agreement (this "Agreement") is entered into as of ${contractDate(f.effectiveDate, L)} (the "Effective Date") by and between the "Client" and "Agency" identified below (each a "Party," and collectively, the "Parties").`));
  b.push(partyTable(f, L));
  b.push({ t: 'space' });
  b.push(P(ko
    ? `에이전시는 인플루언서 섭외, 캠페인 기획 및 운영, 콘텐츠 제작 지원 등 인플루언서 마케팅 대행 서비스를 제공하는 회사이며, 고객사는 이러한 서비스를 제공받고자 한다. 이에 양 당사자는 다음과 같이 합의한다.`
    : `The Agency is an agency that provides influencer marketing agency services, including influencer sourcing, campaign planning and management, and content production support, and the Client wishes to receive such services. Accordingly, the Parties agree as follows.`));

  b.push(H2(ko ? '제1조 (목적)' : 'Article 1 (Purpose)'));
  b.push(P(ko
    ? `본 계약은 에이전시가 고객사에게 인플루언서 마케팅 및 관련 서비스를 제공함에 있어 양 당사자 간의 권리·의무 및 기타 필요한 사항을 정함을 목적으로 한다. 본 계약은 양 당사자가 수시로 체결하는 개별 과업지시서("SOW")에 공통적으로 적용되는 기본 거래조건을 구성하며, 각 SOW는 본 계약의 일부를 이룬다.`
    : `This Agreement sets forth the rights, obligations, and other necessary matters between the Parties in connection with the Agency's provision of influencer marketing and related services to the Client. This Agreement constitutes the basic transaction terms commonly applicable to individual Statements of Work ("SOW") to be entered into by the Parties from time to time, and each SOW forms part of this Agreement.`));

  b.push(H2(ko ? '제2조 (정의)' : 'Article 2 (Definitions)'));
  b.push(P(ko
    ? `1. "서비스"란 SOW에 정한 바에 따라 에이전시가 제공하는 인플루언서 섭외·협상, 캠페인 기획, 실행 및 운영, 콘텐츠 제작 지원, 성과 분석 기타 업무를 말한다.`
    : `1. "Services" means the influencer sourcing/negotiation, campaign planning, execution and management, content production support, performance analysis, and other tasks provided by the Agency as set forth in an SOW.`));
  b.push(P(ko
    ? `2. "결과물"이란 에이전시가 서비스를 수행한 결과로 고객사에게 제공하는 보고서, 콘텐츠, 캠페인 산출물 기타 작업 성과물을 말한다.`
    : `2. "Deliverables" means the reports, content, campaign outputs, and other work product provided by the Agency to the Client as a result of performing the Services.`));
  b.push(P(ko
    ? `3. "SOW"란 본 계약에 따라 개별 프로젝트별로 양 당사자가 서명하는 하위 문서로서, 서비스의 범위, 일정, 대가 및 지급조건을 정한 것을 말한다. 본 계약과 SOW의 내용이 상충하는 경우, 해당 프로젝트에 관하여는 SOW의 규정이 우선한다.`
    : `3. "SOW" means a subordinate document signed by the Parties for each individual project pursuant to this Agreement, setting forth the scope, schedule, fees, and payment terms of the Services. In the event of any conflict between this Agreement and a SOW, the provisions of the SOW shall prevail for that specific project.`));

  b.push(H2(ko ? '제3조 (서비스의 제공)' : 'Article 3 (Provision of Services)'));
  b.push(P(ko ? `1. 에이전시는 SOW에 정한 범위 내에서 성실히 서비스를 제공한다.`
              : `1. The Agency shall faithfully provide the Services within the scope set forth in the SOW.`));
  b.push(P(ko
    ? `2. 고객사는 필요한 정보, 자료, 승인 및 협조를 적시에 제공하여야 하며, 고객사의 자료 제공 지연으로 인한 일정 지연에 대하여 에이전시는 책임을 지지 아니한다.`
    : `2. The Client shall provide necessary information, materials, approvals, and cooperation in a timely manner, and the Agency shall not be liable for any schedule delay caused by the Client's delay in providing materials.`));
  b.push(P(ko
    ? `3. 에이전시가 협업하는 인플루언서 또는 크리에이터의 가용성, 일정 및 단가는 사전 통지 없이 변경될 수 있으며, 이 경우 양 당사자는 협의하여 SOW를 조정한다.`
    : `3. The availability, schedule, and rates of influencers or creators with whom the Agency collaborates may change without prior notice, in which case the Parties shall consult and adjust the SOW accordingly.`));
  b.push(P(ko
    ? `4. 고객사는 에이전시가 제출한 초안 또는 운영 계획에 대하여 제출일로부터 영업일 기준 ${f.reviewDays}일 이내에 검토 후 피드백을 제공하여야 한다. 위 기간 내 피드백이 없는 경우 해당 초안 또는 운영 계획은 고객사가 승인한 것으로 본다.`
    : `4. The Client must review and provide feedback on drafts or operational plans submitted by the Agency within ${f.reviewDays} business days of submission. If no feedback is provided within this period, the relevant draft or operational plan shall be deemed approved by the Client.`));

  b.push(H2(ko ? '제4조 (대가 및 지급)' : 'Article 4 (Fees and Payment)'));
  b.push(P(ko
    ? `1. 고객사는 SOW에 명시된 용역비(이하 "용역비")를 본 조에 정한 조건에 따라 에이전시에게 지급한다.`
    : `1. The Client shall pay the Agency the service fee specified in the SOW (the "Service Fee") in accordance with the terms set forth in this Article.`));
  b.push(P(ko
    ? `2. 에이전시는 서비스 완료 시(또는 SOW에 정한 마일스톤 완료 시) 세금계산서를 발행하며, 고객사는 세금계산서 발행일로부터 ${f.netDays}일 이내에 용역비 전액을 현금으로 지급한다. 다만 SOW에 별도의 지급 일정(선급금, 중도금 등)이 정하여진 경우에는 해당 일정이 우선한다.`
    : `2. The Agency shall issue a tax invoice upon completion of the Services (or completion of a milestone specified in the SOW), and the Client shall pay the full Service Fee in cash within ${f.netDays} days of the tax invoice issuance date; provided, that if the SOW specifies a separate payment schedule (e.g., advance or interim payments), such schedule shall take precedence.`));
  b.push(P(ko
    ? `3. 고객사가 지급기한까지 용역비를 지급하지 아니하는 경우, 에이전시는 미지급액에 대하여 지급기한 다음 날부터 실제 지급일까지 연 ${f.lateInterest}%의 지연손해금을 청구할 수 있으며, 서비스 제공을 중단할 수 있다.`
    : `3. If the Client fails to pay the Service Fee by the due date, the Agency may charge late payment interest of ${f.lateInterest}% per annum on the unpaid amount, calculated from the day following the due date until the date of actual payment, and may suspend provision of the Services.`));
  b.push(P(ko
    ? `4. 용역비에는 부가가치세가 포함되지 아니한다. 관련 법령에 따라 원천징수가 적용되는 경우 해당 금액을 공제하며, 고객사는 에이전시에게 원천징수영수증을 지체 없이 교부한다.`
    : `4. The Service Fee is exclusive of value-added tax. Where withholding tax applies under applicable law, the corresponding amount shall be deducted, and the Client shall promptly provide the Agency with the relevant withholding tax receipt.`));
  b.push(P(ko
    ? `5. 에이전시가 인플루언서 또는 기타 제3자에게 비용을 선지급하여야 하는 경우, 고객사는 SOW에 정한 바에 따라 해당 비용을 선지급하거나 별도의 일정에 따라 지급한다.`
    : `5. If the Agency is required to make advance payments to influencers or other third parties, the Client shall advance such costs, or pay them on a separate schedule, as specified in the SOW.`));

  b.push(H2(ko ? '제5조 (지식재산권)' : 'Article 5 (Intellectual Property)'));
  b.push(P(ko
    ? `1. 결과물에 관한 지식재산권은 용역비 전액이 지급된 때에 고객사에게 이전된다. 전액 지급 전까지 결과물에 관한 권리는 에이전시에게 유보된다.`
    : `1. Ownership of the intellectual property rights in the Deliverables shall transfer to the Client upon full payment of the Service Fee. Prior to full payment, rights in the Deliverables shall remain with the Agency.`));
  b.push(P(ko
    ? `2. SOW에 달리 정하지 아니하는 한, 인플루언서가 직접 제작한 콘텐츠(이하 "인플루언서 콘텐츠")의 저작권은 해당 인플루언서에게 귀속되며, 고객사는 SOW에 명시된 기간 및 매체·플랫폼 범위 내에서 인플루언서 콘텐츠를 사용할 수 있는 제한적 사용권을 부여받는다. SOW에 정한 범위를 초과하는 사용에는 별도의 협의 및 대가 지급을 요한다.`
    : `2. Unless otherwise specified in the SOW, copyright in content directly created by an influencer (the "Influencer Content") shall remain vested in the relevant influencer, and the Client shall be granted a limited license to use the Influencer Content within the period and media/platform scope specified in the SOW. Any additional use beyond what is specified in the SOW shall require separate consultation and payment.`));
  b.push(P(ko
    ? `3. 에이전시가 서비스 수행 이전부터 보유한 방법론, 노하우, 도구, 인플루언서 데이터베이스 및 일반적 업무 관행에 관한 권리는 에이전시에게 유보되며 본 계약에 의하여 고객사에게 이전되지 아니한다.`
    : `3. Rights in methodologies, know-how, tools, influencer databases, and general business practices held by the Agency prior to performing the Services shall remain vested in the Agency and shall not be transferred to the Client under this Agreement.`));
  if (f.clauses.portfolio) b.push(P(ko
    ? `4. 에이전시는 고객사의 사전 서면 동의를 얻어 결과물 또는 캠페인 수행 사실을 에이전시의 포트폴리오 및 레퍼런스 목적으로 활용할 수 있다. 본 권리는 고객사의 기밀정보 또는 영업비밀이 노출되지 아니하는 범위에서 행사되는 것을 조건으로 본 계약의 해지 또는 종료 이후에도 존속한다.`
    : `4. With the Client's prior written consent, the Agency may use the Deliverables or the fact of having performed the campaign for the Agency's portfolio and reference purposes. This right shall survive the termination or expiration of this Agreement, provided that it is exercised within a scope that does not expose the Client's confidential information or trade secrets.`));

  b.push(H2(ko ? '제6조 (기밀유지)' : 'Article 6 (Confidentiality)'));
  b.push(P(ko
    ? `1. "기밀정보"란 인플루언서 연락처, 제안 단가 및 협상 내용, 캠페인 기획, 마케팅 전략 및 예산 기타 본 계약 또는 SOW와 관련하여 일방 당사자가 상대방에게 공개한 비공개 정보를 말한다. 다만 공지된 정보, 독자적으로 개발한 정보 또는 제3자로부터 정당하게 취득한 정보는 제외한다.`
    : `1. "Confidential Information" means influencer contact information, proposed rates and negotiation details, campaign plans, marketing strategy and budget, and other non-public information disclosed by one Party to the other in connection with this Agreement or an SOW; provided, that information that is publicly known, independently developed, or rightfully obtained from a third party is excluded.`));
  b.push(P(ko
    ? `2. 각 당사자는 상대방의 기밀정보를 본 계약 목적 외의 용도로 사용하지 아니하며, 상대방의 사전 서면 동의 없이 제3자에게 공개하지 아니한다. 본 의무는 본 계약 종료 후 ${f.confidentialityYears}년간 존속한다.`
    : `2. Each Party shall not use the other Party's Confidential Information for any purpose other than this Agreement and shall not disclose it to any third party without the other Party's prior written consent. This obligation shall survive for ${f.confidentialityYears} years following termination of this Agreement.`));

  b.push(H2(ko ? '제7조 (독립계약자 관계)' : 'Article 7 (Independent Contractor Relationship)'));
  b.push(P(ko
    ? `에이전시와 고객사는 상호 독립된 사업자이며, 본 계약은 양 당사자 간에 고용, 조합, 대리 또는 합작 관계를 형성하지 아니한다. 에이전시 및 그 인력은 고객사의 근로자가 아니며 고객사를 대리하여 계약을 체결할 권한이 없다.`
    : `The Agency and the Client are independent businesses, and this Agreement does not create an employment, partnership, agency, or joint venture relationship between the Parties. The Agency and its personnel are not employees of the Client and have no authority to enter into any agreement on the Client's behalf.`));

  b.push(H2(ko ? '제8조 (보증 및 책임)' : 'Article 8 (Warranty and Liability)'));
  b.push(P(ko
    ? `1. 에이전시는 통상적인 업계 관행에 따라 전문적으로 서비스를 제공할 것을 보증한다. 다만 도달, 매출, 전환 등 캠페인의 구체적 성과는 인플루언서의 행위, 제3자 플랫폼 정책 등 에이전시가 통제할 수 없는 요인에 따라 달라질 수 있으므로 이를 보증하지 아니한다.`
    : `1. The Agency warrants that it will provide the Services professionally in accordance with ordinary industry practice. However, the Agency does not warrant specific campaign results (e.g., reach, sales, conversions), as these may vary due to factors beyond the Agency's control, including influencer conduct and third-party platform policies.`));
  b.push(P(ko ? `2. 콘텐츠 및 캠페인 실행에 관한 최종 승인과 의사결정의 책임은 고객사에게 있다.`
              : `2. Final approval and decision-making responsibility for content and campaign execution rests with the Client.`));
  b.push(P(ko
    ? `3. 에이전시는 협업 인플루언서에게 관련 법령상 광고·협찬 표시 등 준수사항을 안내한다. 다만 최종 표시 문구의 승인 책임은 고객사에게 있으며, 사전 승인되지 아니한 인플루언서 또는 기타 독립적 제3자 크리에이터의 일방적 행위에 대하여는 에이전시와 고객사 모두 책임을 부담하지 아니한다.`
    : `3. The Agency guides the influencers it works with on compliance matters such as advertisement/sponsorship disclosure requirements under applicable law; however, responsibility for approving the final disclosure wording rests with the Client. Neither the Agency nor the Client shall be liable for any unilateral act taken by an influencer or other independent third-party creator that was not pre-approved.`));

  b.push(H2(ko ? '제9조 (책임의 제한)' : 'Article 9 (Limitation of Liability)'));
  b.push(P(ko
    ? `1. 본 계약 또는 SOW와 관련하여 발생하는 에이전시의 총 책임은 해당 책임을 발생시킨 SOW에 따라 고객사가 에이전시에게 실제로 지급한 용역비 총액을 초과하지 아니한다.`
    : `1. The Agency's total liability arising in connection with this Agreement or an SOW shall not exceed the total Service Fee actually paid by the Client to the Agency under the SOW giving rise to such liability.`));
  b.push(P(ko ? `2. 어느 당사자도 상대방에 대하여 간접손해, 특별손해, 부수적 손해 또는 징벌적 손해나 영업상의 손실 또는 일실이익에 대하여 책임을 지지 아니한다.`
              : `2. Neither Party shall be liable to the other for any indirect, special, incidental, or punitive damages, or for loss of business or profits.`));
  b.push(P(ko ? `3. 제1항 및 제2항은 고의 또는 중과실로 인한 손해에는 적용되지 아니한다.`
              : `3. Paragraphs 1 and 2 shall not apply to damages caused by willful misconduct or gross negligence.`));

  b.push(H2(ko ? '제10조 (계약기간 및 해지)' : 'Article 10 (Term and Termination)'));
  b.push(P(ko
    ? `1. 본 계약은 계약효력발생일에 효력이 발생하며, 조기 해지되지 아니하는 한 ${f.termYears}년간 유효하다. 어느 당사자도 기간 만료 전에 서면으로 이의를 제기하지 아니하는 경우 동일한 조건으로 ${f.termYears}년씩 자동 갱신된다.`
    : `1. This Agreement shall take effect on the Effective Date and remain in effect for ${f.termYears === 1 ? 'one year' : f.termYears + ' years'}, unless terminated earlier, and shall automatically renew for successive ${f.termYears === 1 ? 'one-year' : f.termYears + '-year'} terms on the same conditions unless either Party objects in writing prior to expiration.`));
  b.push(P(ko ? `2. 각 SOW의 기간은 해당 SOW에 정한 바에 따른다.` : `2. The term of each SOW shall be as set forth in the relevant SOW.`));
  b.push(P(ko
    ? `3. 어느 당사자가 본 계약 또는 SOW를 중대하게 위반하고 상대방으로부터 서면 통지를 받은 날로부터 ${f.cureDays}일 이내에 이를 시정하지 아니하는 경우, 위반하지 아니한 당사자는 본 계약 또는 해당 SOW를 즉시 해지할 수 있다.`
    : `3. If either Party materially breaches this Agreement or an SOW and fails to cure such breach within ${f.cureDays} days after receiving written notice thereof from the other Party, the non-breaching Party may immediately terminate this Agreement or the relevant SOW.`));
  b.push(P(ko
    ? `4. 해지일까지 제공된 서비스에 대한 용역비의 지급의무는 존속하며, 고객사는 제4조에 따라 해지일까지 발생한 용역비를 지급한다.`
    : `4. The Service Fee for Services rendered up to the date of termination remains payable, and the Client shall pay any Service Fee accrued through the termination date in accordance with Article 4.`));

  b.push(H2(ko ? '제11조 (불가항력)' : 'Article 11 (Force Majeure)'));
  b.push(P(ko
    ? `천재지변, 전쟁, 정부의 명령, 감염병 등 당사자의 합리적 통제를 벗어난 사유로 인한 의무의 지연 또는 불이행에 대하여는 그 사유가 존속하는 기간 동안 책임을 지지 아니한다. 불가항력 사유가 ${f.forceMajeureDays}일 이상 계속되는 경우 어느 당사자든 서면 통지로써 본 계약 또는 해당 SOW를 해지할 수 있다.`
    : `Neither Party shall be liable for any delay or failure to perform its obligations caused by circumstances beyond its reasonable control, including natural disaster, war, government order, or epidemic, for so long as such circumstances continue. If a force majeure event continues for ${f.forceMajeureDays} days or more, either Party may terminate this Agreement or the relevant SOW upon written notice.`));

  b.push(H2(ko ? '제12조 (통지 및 양도)' : 'Article 12 (Notices and Assignment)'));
  b.push(P(ko
    ? `1. 본 계약에 따른 통지는 서면(이메일 포함)으로 하며, 본 계약 전문에 기재된 주소 또는 당사자가 서면으로 지정한 다른 주소로 발송한다.`
    : `1. Any notice under this Agreement shall be made in writing (including email) and sent to the address set forth in the preamble of this Agreement or to such other address as a Party may designate in a written notice.`));
  b.push(P(ko ? `2. 어느 당사자도 상대방의 사전 서면 동의 없이 본 계약상의 권리 또는 의무를 제3자에게 양도할 수 없다.`
              : `2. Neither Party may assign its rights or obligations under this Agreement to any third party without the other Party's prior written consent.`));

  b.push(H2(ko ? '제13조 (일반조항)' : 'Article 13 (General Provisions)'));
  b.push(P(ko ? `1. 본 계약 및 SOW는 그 대상에 관한 양 당사자 간의 완전한 합의를 구성하며, 이전의 구두 또는 서면 합의를 대체한다.`
              : `1. This Agreement and the SOW constitute the entire agreement between the Parties with respect to the subject matter hereof and supersede all prior oral or written agreements.`));
  b.push(P(ko ? `2. 본 계약의 변경은 양 당사자가 서명한 서면에 의하여만 효력이 있다.`
              : `2. Any amendment to this Agreement shall be effective only if made in writing and signed by both Parties.`));
  b.push(P(ko ? `3. 본 계약의 일부 조항이 무효 또는 집행 불가능하다고 판단되더라도 나머지 조항은 계속하여 완전한 효력을 가진다.`
              : `3. If any provision of this Agreement is held invalid or unenforceable, the remaining provisions shall remain in full force and effect.`));
  if (f.clauses.esign) b.push(P(ko
    ? `4. 본 계약은 전자서명 또는 서명본의 교환 방식으로 체결될 수 있으며, 이는 원본과 동일한 효력을 가진다.`
    : `4. This Agreement may be executed by electronic signature or by exchange of signed counterparts, each of which shall have the same effect as the original.`));

  b.push(H2(ko ? '제14조 (준거법 및 관할)' : 'Article 14 (Governing Law and Jurisdiction)'));
  b.push(P(ko
    ? `본 계약은 ${f.governingLaw === 'Republic of Korea' ? '대한민국' : f.governingLaw} 법률에 따라 규율되고 해석되며, 본 계약과 관련하여 발생하는 분쟁의 제1심 관할법원은 ${f.jurisdiction === 'Seoul Central District Court' ? '서울중앙지방법원' : f.jurisdiction}으로 한다.`
    : `This Agreement shall be governed by and construed in accordance with the laws of the ${f.governingLaw}, and the ${f.jurisdiction} shall have exclusive jurisdiction over any first-instance dispute arising in connection with this Agreement.`));

  if (f.clauses.language) {
    const master = f.masterLanguage === 'ko' ? (ko ? '국문본' : 'Korean version') : (ko ? '영문본' : 'English version');
    b.push(H2(ko ? '제15조 (언어)' : 'Article 15 (Language)'));
    b.push(P(ko
      ? `본 계약 및 SOW는 영문본과 국문본으로 작성될 수 있다. 두 언어본 간에 불일치 또는 해석상의 차이가 있는 경우 ${master}이 우선하며, ${master}을 본 계약과 관련한 모든 법적 절차(소송, 중재 등) 및 해석의 기준이 되는 정본(Master Version)으로 한다.`
      : `This Agreement and the SOW may be prepared in both an English version and a Korean version. In the event of any discrepancy or difference in interpretation between the two language versions, the ${master} shall prevail, and the ${master} shall serve as the Master Version for all legal proceedings (litigation, arbitration, or otherwise) and for purposes of interpretation in connection with this Agreement.`));
  }

  b.push({ t: 'space' });
  b.push(P(ko
    ? `양 당사자는 본 계약의 내용을 충분히 읽고 이해하였으며 이에 동의하고, 이를 증명하기 위하여 아래에 서명 또는 날인한다.`
    : `Each Party acknowledges that it has fully read and understood the contents of this Agreement and agrees thereto, and in witness whereof, the Parties have caused this Agreement to be signed or sealed below.`));
  b.push({ t: 'space' });
  b.push(signatureTable(f, L));
  return b;
}

/* ============================ 2. STATEMENT OF WORK ============================ */
export function buildSOW(f, L) {
  const ko = L === 'ko';
  const b = [];
  const client = fv(f.clientName, 16);
  const agency = fv(f.agencyName, 10);

  b.push({ t: 'h1', text: ko ? '과업지시서 (STATEMENT OF WORK)' : 'STATEMENT OF WORK' });
  b.push(P(ko
    ? `본 과업지시서(이하 "본 SOW")는 ${contractDate(f.effectiveDate, L)}에 ${agency}("에이전시")와 ${client}("고객사") 간에 ${contractDate(f.masterDate, L)}자로 체결된 기본 용역 계약서(이하 "기본계약")에 따라 체결되며, 기본계약의 일부를 이룬다.`
    : `This Statement of Work (this "SOW") is entered into as of ${contractDate(f.effectiveDate, L)} by and between ${agency} ("Agency") and ${client} ("Client") pursuant to the Master Service Agreement dated ${contractDate(f.masterDate, L)} (the "Master Agreement"), and forms part of the Master Agreement.`));
  b.push(P(ko ? `기본계약과 본 SOW의 내용이 상충하는 경우 본 SOW가 우선한다.`
              : `In the event of any conflict between the Master Agreement and this SOW, this SOW shall prevail.`));

  b.push(H2(ko ? '1. 프로젝트 개요' : '1. Project Overview'));
  b.push(P((ko ? 'SOW 번호 / 캠페인명: ' : 'SOW No. / Campaign Name: ') + fv(f.campaignName, 32)));
  b.push(P((ko ? '캠페인 목적 및 개요: ' : 'Campaign Purpose and Overview: ') + fv(f.campaignPurpose, 32)));
  if (f.platforms) b.push(P((ko ? '플랫폼: ' : 'Platform: ') + f.platforms));

  b.push(H2(ko ? '2. 서비스 범위 및 결과물' : '2. Scope of Services and Deliverables'));
  const rows = [[ko ? '서비스 / 결과물' : 'Service / Deliverable', ko ? '플랫폼' : 'Platform', ko ? '수량' : 'Quantity', ko ? '기한' : 'Deadline']];
  const filled = (f.deliverables || []).filter((d) => d.service || d.platform || d.qty || d.deadline);
  (filled.length ? filled : [{}, {}, {}]).forEach((d) => rows.push([d.service || '', d.platform || '', d.qty || '', d.deadline || '']));
  b.push({ t: 'table', rows, widths: [3800, 2000, 1500, 2000], headerRow: true });

  b.push(H2(ko ? '3. 일정' : '3. Schedule'));
  b.push(P((ko ? '캠페인 기간: ' : 'Campaign Period: ') + contractDate(f.periodStart, L) + '  ~  ' + contractDate(f.periodEnd, L)));
  b.push(P((ko ? '주요 마일스톤: ' : 'Key Milestones: ') + fv(f.milestones, 32)));

  b.push(H2(ko ? '4. 용역비 및 지급조건' : '4. Service Fee and Payment Terms'));
  b.push(P((ko ? '총 용역비 (VAT 별도): ' : 'Total Service Fee (VAT excluded): ') + contractMoney(f, L)));
  b.push(P((ko ? '지급 조건: ' : 'Payment Schedule: ') + billingText(f, L) + ' ' + (ko
    ? `각 지급금은 해당 세금계산서 발행일로부터 ${f.netDays}일 이내에 현금으로 지급한다(기본계약 제4조).`
    : `Each payment due in cash within ${f.netDays} days of the corresponding tax invoice issuance date (per Article 4 of the Master Agreement).`)));

  b.push(H2(ko ? '5. 담당자' : '5. Contact Persons'));
  b.push(P((ko ? '고객사 담당자 / 연락처: ' : 'Client Contact / Phone: ') + fv(f.clientContact, 20) + (f.clientPhone ? ' / ' + f.clientPhone : '')));
  b.push(P((ko ? '에이전시 담당자 / 연락처: ' : 'Agency Contact / Phone: ') + fv(f.agencyContact, 20) + (f.agencyPhone ? ' / ' + f.agencyPhone : '')));

  b.push(H2(ko ? '6. 특기사항 / 전제조건' : '6. Special Notes / Assumptions'));
  b.push(P(fv(f.notes, 32)));

  b.push({ t: 'space' });
  b.push(P(ko ? `본 SOW는 기본계약과 함께 효력을 가지며, 양 당사자는 아래에 서명함으로써 본 SOW의 내용에 동의한다.`
              : `This SOW shall be effective together with the Master Agreement, and the Parties agree to the contents of this SOW by signing below.`));
  b.push({ t: 'space' });
  b.push(signatureTable(f, L));
  return b;
}

/* ============================ 3. SHORT-FORM AGREEMENT ============================ */
export function buildShort(f, L) {
  const ko = L === 'ko';
  const b = [];

  b.push({ t: 'h1', text: ko ? '약식 서비스 계약서' : 'SHORT-FORM SERVICE AGREEMENT' });
  b.push({ t: 'sub', text: ko ? '(SHORT-FORM SERVICE AGREEMENT)' : '(약식 서비스 계약서)' });
  b.push(P(ko
    ? `본 계약서(이하 "본 계약")는 아래의 "고객사"와 "에이전시"(이하 개별적으로 "당사자", 총칭하여 "양 당사자") 간에 ${contractDate(f.effectiveDate, L)}("계약일")에 체결되며, 아래 명시된 단일 프로젝트에 한하여 적용되는 약식 계약이다.`
    : `This Agreement (this "Agreement") is entered into as of ${contractDate(f.effectiveDate, L)} (the "Effective Date") between the "Client" and the "Agency" identified below (each a "Party," and collectively, the "Parties"), and is a short-form agreement applying solely to the single project set out below.`));
  b.push(partyTable(f, L));
  b.push({ t: 'space' });

  b.push(H2(ko ? '1. 프로젝트 개요' : '1. Project Overview'));
  b.push(P((ko ? '캠페인/프로젝트명: ' : 'Campaign / Project Name: ') + fv(f.campaignName, 32)));
  b.push(P((ko ? '서비스 범위 및 결과물: ' : 'Scope of Services and Deliverables: ') + fv(f.campaignPurpose, 32)));
  b.push(P((ko ? '플랫폼: ' : 'Platform: ') + fv(f.platforms, 32)));
  b.push(P((ko ? '캠페인 기간: ' : 'Campaign Period: ') + contractDate(f.periodStart, L) + ' ~ ' + contractDate(f.periodEnd, L)));

  b.push(H2(ko ? '2. 대가 및 지급' : '2. Fees and Payment'));
  b.push(P((ko ? '총 용역비 (VAT 별도): ' : 'Total Service Fee (VAT excluded): ') + contractMoney(f, L)));
  b.push(P((ko ? '지급 조건: ' : 'Payment Terms: ') + billingText(f, L) + ' ' + (ko
    ? `각 지급금은 해당 세금계산서 발행일로부터 ${f.netDays}일 이내에 지급한다.`
    : `Each payment is due within ${f.netDays} days of the corresponding tax invoice issuance date.`)));
  if (f.clauses.cancellationFee) {
    b.push({ t: 'h3', text: ko ? '2-1. 지연손해금 및 취소 수수료' : '2-1. Late Payment Interest and Cancellation Fee' });
    b.push(P(ko
      ? `고객사가 지급기한을 경과하여 대금을 지급하지 아니하는 경우, 에이전시는 미지급액에 대하여 연 ${f.lateInterest}%의 지연손해금을 청구할 수 있다. 고객사가 캠페인 개시일 전 ${f.cancelWindowDays}일 이내에 캠페인을 취소하거나 무기한 연기하는 경우, 고객사는 이미 확정된 인플루언서 섭외 및 준비 비용을 고려하여 총 용역비의 ${f.cancelFee}%를 취소 수수료로 에이전시에 지급하여야 한다.`
      : `If the Client fails to pay by the due date, the Agency may charge late payment interest of ${f.lateInterest}% per annum on the unpaid amount. If the Client cancels or indefinitely postpones the campaign within ${f.cancelWindowDays} days before the campaign start date, the Client shall pay the Agency a cancellation fee of ${f.cancelFee}% of the total Service Fee, in consideration of influencer bookings and preparation costs already committed.`));
  }

  b.push(H2(ko ? '3. 지식재산권 및 콘텐츠 사용권' : '3. Intellectual Property and Content Licence'));
  b.push(P(ko
    ? `별도의 서면 합의가 없는 한 인플루언서가 직접 제작한 사진, 영상, 게시글 등 콘텐츠(이하 "인플루언서 콘텐츠")의 저작권 및 지식재산권은 해당 인플루언서에게 귀속되며, 고객사는 용역비 전액 지급 후 합의된 캠페인 범위(플랫폼, 기간 및 목적 등) 내에서 이를 사용할 수 있는 제한적 사용권을 부여받는다. 합의된 범위를 초과하는 유료 광고, 2차 활용, 수정·편집 등을 위해서는 해당 권리자의 사전 서면 승인을 받아야 한다. 에이전시가 별도로 제작한 결과물은 용역비 전액 지급 시 고객사에게 귀속된다.${f.clauses.portfolio ? ` 에이전시는 고객사의 기밀정보를 제외하고 고객사에게 사전 통지 후, 고객사가 통지일로부터 5영업일 이내에 서면으로 이의를 제기하지 않는 한 캠페인 이력을 포트폴리오 및 레퍼런스로 활용할 수 있다.` : ''}`
    : `Unless otherwise agreed in writing, copyright and intellectual property rights in photographs, videos, posts and other content created directly by an influencer (the "Influencer Content") remain vested in that influencer. Upon payment of the Service Fee in full, the Client is granted a limited licence to use such content within the agreed campaign scope (platform, period and purpose). Paid advertising, secondary use, or modification beyond the agreed scope requires the prior written approval of the rights holder. Work product created separately by the Agency vests in the Client upon payment of the Service Fee in full.${f.clauses.portfolio ? ` Excluding the Client's confidential information, the Agency may use the campaign in its portfolio and as a reference after giving the Client prior notice, unless the Client objects in writing within 5 business days of that notice.` : ''}`));
  if (f.clauses.reviewProcess) {
    b.push({ t: 'h3', text: ko ? '3-1. 콘텐츠 검수 절차' : '3-1. Content Review Process' });
    b.push(P(ko
      ? `고객사는 인플루언서 콘텐츠 초안을 수령한 날로부터 영업일 기준 ${f.reviewDays}일 이내에 수정 요청 또는 승인 여부를 서면(이메일 포함)으로 통지하여야 하며, 위 기간 내 회신이 없는 경우 해당 콘텐츠는 승인된 것으로 간주한다. 수정 요청은 콘텐츠별 최대 ${f.revisionRounds}회로 제한하며, 이를 초과하는 수정 요청에는 별도 협의 및 추가 비용이 발생할 수 있다.`
      : `The Client shall notify the Agency in writing (including email) of any revision request or approval within ${f.reviewDays} business days of receiving a draft of the Influencer Content. If no reply is given within that period, the content is deemed approved. Revision requests are limited to ${f.revisionRounds} round${f.revisionRounds === 1 ? '' : 's'} per piece of content; requests beyond that are subject to separate agreement and may incur additional cost.`));
  }

  b.push(H2(ko ? '4. 보증 및 인플루언서 관계' : '4. Warranty and Influencer Relationship'));
  b.push(P(ko
    ? `에이전시는 업계 관행에 따라 전문적으로 서비스를 제공하나 캠페인의 구체적 성과(조회수, 매출, 전환 등)를 보증하지 아니한다. 고객사는 캠페인에 참여하는 인플루언서가 에이전시의 직원 또는 대리인이 아닌 독립적인 제3자임을 인정하며, 에이전시는 캠페인 진행에 필요한 커뮤니케이션을 지원하고, 광고·협찬 표시 등 관련 준수사항을 인플루언서에게 안내한다. 단, 승인된 캠페인 범위를 벗어난 인플루언서 또는 제3자의 독립적인 행위에 대해서는 에이전시가 책임을 부담하지 아니한다.`
    : `The Agency will provide the Services professionally in accordance with industry practice but does not warrant specific campaign results (views, sales, conversions and the like). The Client acknowledges that influencers participating in the campaign are independent third parties and not employees or agents of the Agency. The Agency supports the communication required to run the campaign and briefs influencers on compliance matters such as advertising and sponsorship disclosure. The Agency is not liable for the independent acts of an influencer or third party outside the approved campaign scope.`));
  if (f.clauses.indemnity) {
    b.push({ t: 'h3', text: ko ? '4-1. 면책 및 인플루언서 대체' : '4-1. Indemnity and Influencer Substitution' });
    b.push(P(ko
      ? `고객사는 (i) 고객사가 제공한 제품, 서비스, 정보 또는 소재의 하자, 허위·과장 표시 또는 관련 법령 위반, (ii) 고객사의 지시에 따른 콘텐츠 제작으로 인하여 에이전시 또는 인플루언서에게 발생하는 모든 손해, 청구, 분쟁 및 비용(합리적인 변호사 비용 포함)을 배상하고, 에이전시 및 인플루언서를 면책하여야 한다. 인플루언서가 질병, 계정 정지, 불가항력 등 불가피한 사유로 캠페인을 수행할 수 없는 경우, 에이전시는 고객사와 협의하여 유사한 조건의 인플루언서로 이를 대체할 권리를 가진다.`
      : `The Client shall indemnify and hold harmless the Agency and the influencers against all damages, claims, disputes and costs (including reasonable legal fees) arising from (i) defects, false or exaggerated claims, or breaches of applicable law in the products, services, information or materials supplied by the Client, or (ii) content produced at the Client's direction. Where an influencer cannot perform for unavoidable reasons such as illness, account suspension or force majeure, the Agency has the right, in consultation with the Client, to substitute an influencer on comparable terms.`));
  }
  if (f.clauses.nonCircumvention) {
    b.push({ t: 'h3', text: ko ? '4-2. 비경유 금지 (Non-Circumvention)' : '4-2. Non-Circumvention' });
    b.push(P(ko
      ? `고객사는 본 계약에 따라 에이전시로부터 소개받은 인플루언서에 대하여, 캠페인 종료일로부터 ${f.nonCircMonths}개월간 에이전시를 배제하고 직접 또는 제3자를 통하여 접촉, 협상 또는 계약을 체결하지 아니한다. 이를 위반하는 경우 고객사는 해당 인플루언서와 직접 또는 간접적으로 체결한 거래의 총 계약금액의 ${f.nonCircPenalty}%에 해당하는 금액을 위약벌로 에이전시에 지급하여야 한다.`
      : `For ${f.nonCircMonths} months from the campaign end date, the Client shall not contact, negotiate with, or contract with any influencer introduced by the Agency under this Agreement, whether directly or through a third party, so as to exclude the Agency. In breach of this clause, the Client shall pay the Agency a penalty equal to ${f.nonCircPenalty}% of the total contract value of any transaction concluded directly or indirectly with that influencer.`));
  }

  b.push(H2(ko ? '5. 기밀유지' : '5. Confidentiality'));
  b.push(P(ko
    ? `양 당사자는 본 계약과 관련하여 상대방으로부터 제공받은 비공개 정보를 제3자에게 공개하거나 본 계약 목적 외에 사용하지 아니하며, 본 의무는 계약 종료 후 ${f.confidentialityYears}년간 존속한다.`
    : `Neither Party shall disclose to any third party, or use for any purpose other than this Agreement, non-public information received from the other Party in connection with this Agreement. This obligation survives for ${f.confidentialityYears} years after termination.`));

  b.push(H2(ko ? '6. 책임의 제한 및 계약기간' : '6. Limitation of Liability and Term'));
  b.push(P(ko
    ? `에이전시의 총 책임은 본 계약에 따라 고객사가 실제로 지급한 용역비 총액을 초과하지 아니한다. 에이전시는 어떠한 경우에도 일실이익, 간접손해, 결과적 손해 또는 징벌적 손해에 대하여 책임을 지지 아니한다. 본 계약은 위 캠페인 기간 동안 유효하며, 일방이 본 계약을 중대하게 위반하고 상대방의 서면 통지 후 ${f.cureDays}일 이내에 이를 시정하지 아니하는 경우, 상대방은 본 계약을 즉시 해지할 수 있다.`
    : `The Agency's total liability shall not exceed the total Service Fee actually paid by the Client under this Agreement. In no event is the Agency liable for lost profits, indirect, consequential or punitive damages. This Agreement remains in effect for the campaign period stated above. If a Party materially breaches this Agreement and fails to cure within ${f.cureDays} days of the other Party's written notice, the other Party may terminate immediately.`));
  if (f.clauses.forceMajeure) {
    b.push({ t: 'h3', text: ko ? '6-1. 불가항력' : '6-1. Force Majeure' });
    b.push(P(ko
      ? `천재지변, 전쟁, 감염병, 정부 조치, 플랫폼 장애 등 당사자의 합리적 통제를 벗어난 사유로 본 계약상 의무의 이행이 지연되거나 불가능하게 되는 경우, 해당 당사자는 그 사유가 존속하는 기간 동안 이에 대한 책임을 지지 아니하며, 지체 없이 상대방에게 이를 통지하여야 한다.`
      : `Where performance is delayed or prevented by causes beyond a Party's reasonable control — natural disaster, war, epidemic, government action, platform outage and the like — that Party is not liable for so long as the cause continues, and shall notify the other Party without delay.`));
  }
  if (f.clauses.terminationEffect) {
    b.push({ t: 'h3', text: ko ? '6-2. 해지의 효과' : '6-2. Effect of Termination' });
    b.push(P(ko
      ? `계약이 해지되는 경우, 고객사는 해지 시점까지 에이전시가 수행한 서비스에 상응하는 용역비를 지급하여야 하며, 이미 지급된 금액은 해당 용역비에 충당한다.`
      : `On termination, the Client shall pay the Service Fee corresponding to the Services performed by the Agency up to the point of termination; amounts already paid are applied against that fee.`));
  }

  b.push(H2(ko ? '7. 기타' : '7. General'));
  b.push(P(ko
    ? `본 계약에서 정하지 않은 사항은 양 당사자 간 별도의 서면 합의에 따르며, 별도의 마스터 서비스 계약이 체결된 경우 해당 계약의 관련 조항을 적용한다.`
    : `Matters not provided for in this Agreement are governed by separate written agreement between the Parties. Where a Master Service Agreement has been executed, the relevant provisions of that agreement apply.`));
  if (f.clauses.esign) {
    b.push({ t: 'h3', text: ko ? '7-1. 계약의 변경, 양도 및 전자서명' : '7-1. Amendment, Assignment and Electronic Signature' });
    b.push(P(ko
      ? `본 계약의 변경은 양 당사자가 서명한 서면에 의해서만 유효하며, 어느 당사자도 상대방의 사전 서면 동의 없이 본 계약상의 권리·의무를 제3자에게 양도할 수 없다. 본 계약은 전자서명법에 따른 전자서명 및 전자문서의 방식으로 체결될 수 있으며, 이는 서면 계약과 동일한 효력을 가진다.`
      : `Amendments are effective only if made in writing and signed by both Parties. Neither Party may assign its rights or obligations to a third party without the other Party's prior written consent. This Agreement may be executed by electronic signature and as an electronic document under the applicable electronic signature legislation, with the same effect as a written contract.`));
  }
  if (f.clauses.nonCircumvention) {
    b.push(H2(ko ? '8. 크리에이터 비유인 및 우회거래 금지' : '8. Creator Non-Solicitation and Non-Circumvention'));
    b.push(P(ko
      ? `고객사는 에이전시가 본 캠페인 또는 용역 수행 과정에서 최초로 발굴, 섭외 또는 연결한 크리에이터에 대하여, 해당 캠페인 종료일로부터 ${f.nonCircMonths}개월간 에이전시의 사전 서면 동의 없이 에이전시를 배제하고 직접 또는 제3자를 통하여 광고, 협찬, 콘텐츠 제작, 공동구매, 앰배서더 활동 기타 이에 준하는 상업적 거래를 제안하거나 체결하여서는 아니 된다.`
      : `For ${f.nonCircMonths} months from the campaign end date, the Client shall not, without the Agency's prior written consent, propose or conclude advertising, sponsorship, content production, group-buy, ambassador or comparable commercial arrangements — directly or through a third party, excluding the Agency — with any creator first identified, sourced or introduced by the Agency in the course of this campaign or the Services.`));
  }

  b.push({ t: 'space' });
  b.push(P(ko
    ? `양 당사자는 본 계약의 내용을 충분히 이해하고 이에 동의하며, 이를 증명하기 위하여 아래에 서명 또는 날인한다.`
    : `Each Party acknowledges that it has fully understood and agrees to the contents of this Agreement, and in witness whereof signs or seals below.`));
  b.push({ t: 'space' });
  b.push(signatureTable(f, L));
  return b;
}

export const CONTRACT_DOCS = {
  msa:   { id: 'msa',   label: 'Master Service Agreement', sub: 'long form, covers every SOW', build: buildMSA,
           file: 'MSA', ko: '기본 용역 계약서' },
  sow:   { id: 'sow',   label: 'Statement of Work',        sub: 'one project under an MSA',    build: buildSOW,
           file: 'SOW', ko: '과업지시서' },
  short: { id: 'short', label: 'Short-form Agreement',     sub: '약식 · single project, no MSA', build: buildShort,
           file: 'ShortForm', ko: '약식 서비스 계약서' }
};
export const CONTRACT_TABS = [['draft', 'Draft'], ['clauses', 'Clauses & terms'], ['preview', 'Full preview']];
