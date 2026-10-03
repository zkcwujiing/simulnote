/**
 * 常量：停用词、会议高频词中英对照、决策/行动线索短语。
 *
 * 为什么要有内置词表：摘要是**抽取式**的，不做生成，所以「中英对照」这件事
 * 需要一个最小的词表兜底。词表只影响关键词面板的观感，不影响纪要正确性，
 * 因此宁可小而准，不要大而全（大词表会拖慢手机端启动）。
 */

/** TextRank 与关键词统计用的英文停用词。刻意精简：只去掉纯功能词。 */
export const STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'than', 'that', 'this', 'these', 'those',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'do', 'does', 'did', 'done',
  'have', 'has', 'had', 'having', 'will', 'would', 'shall', 'should', 'can', 'could',
  'may', 'might', 'must', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'from', 'by',
  'as', 'into', 'about', 'over', 'after', 'before', 'between', 'under', 'above',
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them',
  'my', 'your', 'his', 'its', 'our', 'their', 'mine', 'yours', 'ours', 'theirs',
  'so', 'such', 'not', 'no', 'nor', 'too', 'very', 'just', 'also', 'there', 'here',
  'when', 'where', 'why', 'how', 'what', 'which', 'who', 'whom', 'whose',
  'all', 'any', 'both', 'each', 'few', 'more', 'most', 'other', 'some', 'only',
  'own', 'same', 'up', 'down', 'out', 'off', 'again', 'further', 'once',
  'because', 'while', 'during', 'through', 'against', 'upon', 'within', 'without',
  'get', 'got', 'go', 'going', 'gone', 'make', 'made', 'take', 'took', 'taken',
  'see', 'saw', 'seen', 'say', 'said', 'says', 'know', 'knew', 'known',
  'think', 'thought', 'want', 'wanted', 'need', 'needed', 'like', 'well', 'now',
  'okay', 'ok', 'yeah', 'yes', 'um', 'uh', 'er', 'ah', 'oh', 'hmm',
  'kind', 'sort', 'thing', 'things', 'stuff', 'lot', 'lots', 'bit',
  'one', 'two', 'three', 'first', 'second', 'third', 'next', 'last', 'new', 'old',
  'let', 'let\'s', 'lets', 'actually', 'basically', 'really', 'maybe', 'perhaps',
  'right', 'sure', 'still', 'even', 'much', 'many', 'way', 'back', 'around',
  'us', 'via', 'per', 'etc', 'ok', 'alright', 'gonna', 'wanna', 'gotta',
]);

/**
 * 会议 / 工程场景高频词的中英对照。
 * 关键词面板用它把「keyword」标成中文；查不到就只显示英文，不编造。
 */
export const GLOSSARY: Readonly<Record<string, string>> = {
  // 时间与节奏
  schedule: '排期', deadline: '截止时间', timeline: '时间线', quarter: '季度',
  sprint: '迭代', milestone: '里程碑', release: '发布', launch: '上线',
  // 组织与协作
  team: '团队', meeting: '会议', project: '项目', owner: '负责人',
  stakeholder: '相关方', customer: '客户', client: '客户', partner: '合作方',
  // 商业
  budget: '预算', cost: '成本', price: '价格', pricing: '定价',
  revenue: '营收', profit: '利润', margin: '利润率', growth: '增长',
  market: '市场', contract: '合同', invoice: '发票', funding: '融资',
  // 产品与技术
  product: '产品', feature: '功能', roadmap: '路线图', requirement: '需求',
  design: '设计', architecture: '架构', performance: '性能', latency: '延迟',
  security: '安全', privacy: '隐私', compliance: '合规', data: '数据',
  model: '模型', api: '接口', server: '服务器', backend: '后端',
  frontend: '前端', database: '数据库', deploy: '部署', deployment: '部署',
  test: '测试', testing: '测试', bug: '缺陷', issue: '问题', incident: '故障',
  workflow: '工作流', pipeline: '流水线', migration: '迁移', integration: '集成',
  // 抽象与管理
  plan: '计划', strategy: '策略', goal: '目标', target: '目标', objective: '目标',
  risk: '风险', blocker: '阻塞项', dependency: '依赖', scope: '范围',
  priority: '优先级', resource: '资源', capacity: '产能', quality: '质量',
  process: '流程', policy: '策略', standard: '标准', guideline: '规范',
  // 结果
  result: '结果', report: '报告', metric: '指标', kpi: '考核指标',
  feedback: '反馈', user: '用户', usage: '使用量', retention: '留存',
  // AI 场景
  ai: '人工智能', llm: '大语言模型', training: '训练', inference: '推理',
  accuracy: '准确率', benchmark: '基准', dataset: '数据集',
};

/** 表示「这已经拍板了」的英文线索。命中即视为结论候选。 */
export const DECISION_CUES: readonly string[] = [
  'we decided', 'we have decided', "we've decided", 'decided to', 'decision is',
  'we agreed', 'agreed to', 'agreed that', 'consensus is', 'we concluded',
  'the conclusion', 'we will go with', "we'll go with", 'we are going with',
  'final answer', 'final decision', 'settled on', 'we chose', 'we picked',
  'the plan is', 'the approach is', 'approved', 'sign off', 'signed off',
  'confirmed that', 'it is confirmed', "it's confirmed",
];

/** 表示「还要做某件事」的英文线索。命中即视为行动项候选。 */
export const ACTION_CUES: readonly string[] = [
  'action item', 'to-do', 'todo', 'next step', 'next steps', 'follow up',
  'follow-up', 'i will', "i'll", 'we will', "we'll", 'you will', "you'll",
  'they will', "they'll", 'need to', 'needs to', 'have to', 'has to',
  'should do', 'will do', 'let us', "let's", 'please ', 'make sure',
  'by monday', 'by tuesday', 'by wednesday', 'by thursday', 'by friday',
  'by next week', 'by end of', 'before the', 'deadline',
];

/** 摘要写作里不应该作为句子开头的连接词，用于截断噪声。 */
export const LEADING_FILLER: readonly RegExp[] = [
  /^(so|okay|ok|well|yeah|right|and|but|now|then|um|uh|alright)[,\s]+/i,
];
