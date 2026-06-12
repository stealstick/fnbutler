/**
 * 섹터 분류 — KSIC(한국표준산업분류) 산업코드 앞 2자리를 광역 섹터로 묶는다.
 * codeNameKR(예: "고무제품 제조업")은 수백 종으로 너무 세분화돼 섹터 집계에 부적합.
 * GICS 비슷하게 ~18개 투자 섹터로 정규화한다(슬러그=URL, 한글명=표시).
 */

export interface Sector {
  code: string; // URL 슬러그
  name: string; // 표시명(한글)
  order: number; // 표시 순서
}

const SECTORS: Record<string, Sector> = {
  semiconductor: { code: "semiconductor", name: "반도체·전자부품", order: 1 },
  it_software: { code: "it_software", name: "IT·소프트웨어·게임", order: 2 },
  telecom_media: { code: "telecom_media", name: "통신·미디어", order: 3 },
  auto: { code: "auto", name: "자동차·부품", order: 4 },
  chemicals: { code: "chemicals", name: "화학·2차전지소재", order: 5 },
  pharma_bio: { code: "pharma_bio", name: "제약·바이오·헬스케어", order: 6 },
  steel_metal: { code: "steel_metal", name: "철강·금속", order: 7 },
  machinery: { code: "machinery", name: "기계·전기장비", order: 8 },
  shipbuilding: { code: "shipbuilding", name: "조선·기타운송장비", order: 9 },
  construction: { code: "construction", name: "건설·건자재", order: 10 },
  transport: { code: "transport", name: "운송·물류", order: 11 },
  consumer: { code: "consumer", name: "소비재·유통", order: 12 },
  food_bev: { code: "food_bev", name: "음식료·담배", order: 13 },
  energy_util: { code: "energy_util", name: "에너지·유틸리티", order: 14 },
  financials: { code: "financials", name: "은행·보험·증권", order: 15 },
  holding: { code: "holding", name: "지주·기타금융", order: 16 },
  realestate: { code: "realestate", name: "건설·부동산서비스", order: 17 },
  materials_misc: { code: "materials_misc", name: "소재·기타제조", order: 18 },
  services: { code: "services", name: "서비스·전문", order: 19 },
  etc: { code: "etc", name: "기타", order: 99 },
};

// KSIC 2자리 → 섹터 슬러그
const KSIC2: Record<string, string> = {
  "01": "consumer", "02": "consumer", "03": "consumer", // 농림어업
  "05": "energy_util", "06": "energy_util", "07": "steel_metal", "08": "materials_misc", // 광업
  "10": "food_bev", "11": "food_bev", "12": "food_bev", // 식료품·음료·담배
  "13": "consumer", "14": "consumer", "15": "consumer", // 섬유·의복·가죽
  "16": "materials_misc", "17": "materials_misc", "18": "materials_misc", // 목재·종이·인쇄
  "19": "energy_util", // 코크스·석유정제
  "20": "chemicals", "21": "pharma_bio", "22": "chemicals", // 화학·의약·고무플라스틱
  "23": "construction", // 비금속광물(시멘트 등)
  "24": "steel_metal", "25": "steel_metal", // 1차금속·금속가공
  "26": "semiconductor", // 전자부품·컴퓨터·반도체
  "27": "machinery", // 의료·정밀·광학
  "28": "machinery", "29": "machinery", // 전기장비·기계
  "30": "auto", // 자동차·부품
  "31": "shipbuilding", // 기타 운송장비(조선·항공)
  "32": "consumer", "33": "materials_misc", // 가구·기타제조
  "35": "energy_util", "36": "energy_util", "37": "energy_util", "38": "energy_util", "39": "energy_util",
  "41": "construction", "42": "construction", // 건설
  "45": "consumer", "46": "consumer", "47": "consumer", // 도소매
  "49": "transport", "50": "transport", "51": "transport", "52": "transport", // 운수
  "55": "consumer", "56": "consumer", // 숙박·음식
  "58": "it_software", "59": "telecom_media", "60": "telecom_media", "61": "telecom_media",
  "62": "it_software", "63": "it_software", // SW·IT서비스
  "64": "financials", "65": "financials", "66": "holding", // 금융·보험·금융보조
  "68": "realestate", // 부동산
  "70": "services", "71": "services", "72": "services", "73": "services", // 전문서비스
  "74": "services", "75": "services",
  "84": "services", "85": "services", "86": "pharma_bio", // 보건(병원)
  "90": "telecom_media", "91": "services",
};

/** industryCode → 섹터. 지주사(코드 64/66 또는 이름에 '지주') 보정. */
export function classifySector(industryCode?: string | null, codeNameKR?: string | null): Sector {
  if (codeNameKR && /지주/.test(codeNameKR)) return SECTORS.holding;
  if (!industryCode) return SECTORS.etc;
  const two = industryCode.slice(0, 2);
  const slug = KSIC2[two];
  return slug ? SECTORS[slug] : SECTORS.etc;
}

export function sectorByCode(code: string): Sector | undefined {
  return SECTORS[code];
}

export function allSectors(): Sector[] {
  return Object.values(SECTORS).sort((a, b) => a.order - b.order);
}
