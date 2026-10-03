/**
 * 英文数词 → 数值 / 中文表述。
 *
 * 为什么值得单独写一个模块：
 *   hayamimi 的 Limitations 明确指出小模型「numeric values are not reliably
 *   preserved」。数字（金额、比例、日期、工期）恰恰是纪要里最不能错的部分。
 *   所以本项目的做法是：**数字不走翻译模型**，直接从英文原文用规则解析出来，
 *   再用确定性规则渲染成中文。这样即使翻译模型把 "fifteen percent" 翻成
 *   "五成"，纪要里的数字仍然是 15%。
 *
 * 渲染策略：阿拉伯数字 + 中文单位（"12%"、"350 万"、"3 天"），
 * 因为中文里阿拉伯数字本就是常规写法，且绝无歧义。
 */

const SMALL: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19,
};

const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

const SCALES: Record<string, number> = {
  hundred: 100,
  thousand: 1_000,
  million: 1_000_000,
  billion: 1_000_000_000,
  trillion: 1_000_000_000_000,
};

const NUM_WORD_KEYS = new Set([
  ...Object.keys(SMALL),
  ...Object.keys(TENS),
  ...Object.keys(SCALES),
  'and', 'a', 'an', 'half', 'quarter',
]);

export function isNumberWord(word: string): boolean {
  return NUM_WORD_KEYS.has(word.toLowerCase());
}

/**
 * 把一串英文数词解析成数值。
 * 支持 "twelve"、"twenty five"、"three hundred and fifty"、"2.5"、"one and a half"。
 * 解析不出来返回 null —— 宁可漏，不可错。
 */
export function numberFromWords(words: string[]): number | null {
  let total = 0;
  let current = 0;
  let seen = false;

  for (const rawWord of words) {
    const word = rawWord.toLowerCase().replace(/[^a-z0-9.]/g, '');
    if (!word) continue;

    if (word === 'and' || word === 'a' || word === 'an') {
      // "a hundred" = 100；单独的 "a" 不产生数值
      continue;
    }

    if (word === 'half') {
      current += 0.5;
      seen = true;
      continue;
    }
    if (word === 'quarter') {
      current += 0.25;
      seen = true;
      continue;
    }

    if (/^\d+(\.\d+)?$/.test(word)) {
      current += Number(word);
      seen = true;
      continue;
    }

    if (word in SMALL) {
      current += SMALL[word];
      seen = true;
      continue;
    }
    if (word in TENS) {
      current += TENS[word];
      seen = true;
      continue;
    }
    if (word in SCALES) {
      const scale = SCALES[word];
      if (scale === 100) {
        current = (current || 1) * 100;
      } else {
        total += (current || 1) * scale;
        current = 0;
      }
      seen = true;
      continue;
    }
    // 出现非数词 → 终止解析，只用已解析到的部分
    break;
  }

  if (!seen) return null;
  return total + current;
}

/** 小数保留最多 3 位，末尾去零。 */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toFixed(3)));
}

const CURRENCY_ZH: Record<string, string> = {
  $: '美元',
  usd: '美元',
  dollar: '美元',
  dollars: '美元',
  '€': '欧元',
  eur: '欧元',
  euro: '欧元',
  euros: '欧元',
  '£': '英镑',
  gbp: '英镑',
  pound: '英镑',
  pounds: '英镑',
  '¥': '元',
  rmb: '人民币',
  yuan: '元',
  jpy: '日元',
  yen: '日元',
};

const SCALE_ZH: Record<string, string> = {
  hundred: '百',
  thousand: '千',
  million: '万',
  billion: '亿',
  trillion: '万亿',
};

const DURATION_ZH: Record<string, string> = {
  second: '秒', seconds: '秒',
  minute: '分钟', minutes: '分钟',
  hour: '小时', hours: '小时',
  day: '天', days: '天',
  week: '周', weeks: '周',
  month: '个月', months: '个月',
  quarter: '个季度', quarters: '个季度',
  year: '年', years: '年',
};

export function currencyZh(raw: string): string | null {
  const key = raw.toLowerCase().replace(/[^a-z$€£¥]/g, '');
  if (!key) return null;
  if (CURRENCY_ZH[key]) return CURRENCY_ZH[key];
  // "US dollars" / "Australian dollars"
  const last = key.split(/\s+/).pop() ?? key;
  return CURRENCY_ZH[last] ?? null;
}

export function scaleZh(raw: string): string | null {
  return SCALE_ZH[raw.toLowerCase()] ?? null;
}

export function durationZh(raw: string): string | null {
  return DURATION_ZH[raw.toLowerCase()] ?? null;
}
