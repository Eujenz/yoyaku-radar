// Everything a human owner may want to change lives here or in the matching env var.
const env = process.env;
const url = (env.SITE_URL || 'https://eujenz.github.io/yoyaku-radar').replace(/\/+$/, '');

export const SITE = {
  name: env.SITE_NAME || '預購雷達',
  nameEn: env.SITE_NAME_EN || 'Yoyaku Radar',
  tagline: '公仔・周邊預購截止日與再販提醒',
  url,
  base: new URL(url).pathname.replace(/\/+$/, ''), // '' or '/yoyaku-radar'
  contactEmail: env.CONTACT_EMAIL || null,
  threadsUrl: env.THREADS_URL || null,
  // Newsletter: set once a provider is chosen; until then the subscribe page offers RSS + calendar only.
  newsletterFormAction: env.NEWSLETTER_FORM_ACTION || null,
  googleSiteVerification: env.GOOGLE_SITE_VERIFICATION || null,
  indexNowKey: env.INDEXNOW_KEY || null,
  // Monetisation is off until there is traffic. Map of hostname -> (url) => affiliate url.
  affiliate: {},
};

export const SOURCES = {
  gsc: { name: 'Good Smile Company 官方網站', short: 'Good Smile Company', url: 'https://www.goodsmile.com/ja' },
};
