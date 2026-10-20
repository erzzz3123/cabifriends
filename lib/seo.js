// Server-rendered pages for search engines and link previews.
// Pure (no I/O): api/page.js passes in the app shell, the live data and the Japanese labels.
// Every URL exists in English (/friend/morita-shoyu) and Japanese (?lang=ja), linked with hreflang.
// The app (app.html) still draws the page in the browser; the text rendered here sits in <main> until it does.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const json = (o) => JSON.stringify(o).replace(/</g, '\\u003c');
const clip = (s, n = 158) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s; };
const SEASONS = { en: ['Spring', 'Summer', 'Autumn', 'Winter'], ja: ['春', '夏', '秋', '冬'] };
const BRAND = 'Cabi & Friends';
const DEFAULT_IMAGE = { path: '/assets/og-social.jpg', w: 1200, h: 630, alt: 'Illustrations of Japanese foods: dango, bamboo shoots, asparagus, soba, sea bream, bonito flakes, sasa dango and eggplant' };

export function renderPage({ pathname, search = '', data, ja: jaData = {}, shell, site, gaId = '', production = true }) {
  const q = new URLSearchParams(search);
  const lang = q.get('lang') === 'ja' ? 'ja' : 'en';
  const J = lang === 'ja';
  const T = (en, j) => (J ? j : en);
  const TERMS = jaData.JA_TERMS || {}, DESC = jaData.JA_DESC || {};
  const tr = (s) => (J && s ? TERMS[s] || s : s);
  const trList = (s) => String(s || '').split(' · ').filter(Boolean).map(tr).join(' · ');
  const L = (p) => p + (J ? (p.includes('?') ? '&' : '?') + 'lang=ja' : '');
  const { FRIENDS = [], PREFS = [] } = data || {};
  const P = Object.fromEntries(PREFS.map((p) => [p.slug, p]));
  const F = Object.fromEntries(FRIENDS.map((f) => [f.slug, f]));
  const pName = (p) => (J ? p.name_ja : p.name_en);
  const fName = (f) => (J ? f.name_ja || f.name_en : f.name_en);
  const pDesc = (p) => (J ? DESC[p.slug] || p.description : p.description);
  const fDesc = (f) => (J ? f.description_ja || f.description : f.description);
  const imgUrl = (src) => {
    if (!src || /\.(mp4|m4v|webm|mov)(\?|#|$)/i.test(src)) return null;
    if (src.startsWith('assets/') || src.startsWith('/assets/')) return site + '/' + src.replace(/^\//, '');
    if (/\/storage\/v1\/object\/public\/producer_images\//.test(src)) return `${site}/_vercel/image?url=${encodeURIComponent(src)}&w=1600&q=80`;
    return /^https?:\/\//.test(src) ? src : null;
  };
  const friendLi = (f) => `<li><a href="${L('/friend/' + f.slug)}">${esc(fName(f))}</a>${!J && f.name_ja ? ` <span lang="ja">${esc(f.name_ja)}</span>` : ''} · ${esc(pName(P[f.prefecture]))} · ${esc(trList(f.makes))}</li>`;
  const prefLi = (p) => { const n = FRIENDS.filter((f) => f.prefecture === p.slug).length; return `<li><a href="${L('/pref/' + p.slug)}">${esc(pName(p))}</a> · ${esc(p.specialties.slice(0, 4).map(tr).join(', '))}${n ? ` · ${T(n + (n === 1 ? ' Friend' : ' Friends'), '友人' + n)}` : ''}</li>`; };
  const crumbs = (items) => ({ '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: items.map(([name, path], i) => ({ '@type': 'ListItem', position: i + 1, name, item: site + L(path) })) });
  const org = { '@type': 'Organization', name: 'Cabi Foods', url: 'https://cabifoods.com' };

  const [r = '', a] = pathname.replace(/^\/+/, '').split('/').filter(Boolean).map(decodeURIComponent);
  let page;
  if (r === '' || r === 'directory') {
    page = {
      path: '/',
      title: T(`${BRAND} · People, places & food we love across Japan`, `${BRAND} · 日本各地のつくり手と、土地と、食べ物`),
      desc: T('Meet the makers keeping Japan’s everyday flavours alive. A directory of the producers, farmers and makers Cabi knows by name, with food guides to all 47 prefectures.',
        '日本の毎日の味を守り続けるつくり手たちのディレクトリ。Cabiが名前で呼び合う生産者、農家、つくり手と、47都道府県の食ガイド。'),
      ld: [{ '@context': 'https://schema.org', '@type': 'WebSite', name: BRAND, url: site + '/', inLanguage: ['en', 'ja'], publisher: org }],
      body: `<h1>${T('Meet the makers keeping Japan’s everyday flavours alive.', '日本の毎日の味を守り続ける、つくり手たちへ。')}</h1>
<p>${T('A directory of the people and places behind the food we love: brewers, farmers, salt makers and foragers we know by name, across all 47 prefectures.', '私たちが愛する食べ物の向こうにいる人と土地のディレクトリ。名前で呼び合える蔵元、農家、塩づくり、山の草木を採る人たちが、47都道府県に広がっています。')}</p>
<h2>${T('Friends', '友人')}</h2><ul>${FRIENDS.map(friendLi).join('')}</ul>
<h2>${T('Food guides to all 47 prefectures', '47都道府県の食ガイド')}</h2><ul>${PREFS.map(prefLi).join('')}</ul>`,
    };
  } else if (r === 'map' && !a) {
    const regions = [...new Set(PREFS.map((p) => p.region))];
    page = {
      path: '/map',
      title: T(`Map of Japan’s producers · ${BRAND}`, `地図 · 日本各地のつくり手 · ${BRAND}`),
      desc: T('Explore Cabi’s Friends and the food of all 47 prefectures on a map of Japan, region by region.', 'Cabiの友人と47都道府県の食を、日本地図で地域ごとにたどれます。'),
      ld: [crumbs([[BRAND, '/'], [T('Map', '地図'), '/map']])],
      body: `<h1>${T('Map of Japan', '日本地図')}</h1>${regions.map((rg) => `<h2>${esc(tr(rg))}</h2><ul>${PREFS.filter((p) => p.region === rg).map(prefLi).join('')}</ul>`).join('')}`,
    };
  } else if (r === 'about') {
    page = {
      path: '/about',
      title: T(`About · ${BRAND}`, `Cabi & Friendsについて · ${BRAND}`),
      desc: T('Behind every good food in Japan, there is someone. Cabi & Friends maps the quiet network of brewers, farmers, salt makers and foragers behind Japan’s food, and brings it beyond Japan.',
        '日本のおいしいものの向こうには、いつも誰かがいる。Cabi & Friendsは、日本の食を支える蔵元、農家、塩づくり、山の草木を採る人たちのつながりを地図にし、日本の外へ届けています。'),
      ld: [crumbs([[BRAND, '/'], [T('About', '概要'), '/about']])],
      body: `<h1>${T('Behind every good food in Japan, there is someone.', '日本のおいしいものの向こうには、いつも誰かがいる。')}</h1>
<p>${T('What if you knew who brewed your soy sauce? Which island your salt came from, which family pressed your sesame oil, which valley grew your tea?', 'もしも、いつもの醤油を誰が仕込んだのか知っていたら。塩がどの島から来て、ごま油をどの家族が搾り、お茶がどの谷で育ったのかを知っていたら。')}</p>
<p>${T('Food in Japan is made by a quiet network of people. Brewers, farmers, salt makers, millers, foragers. Most are small, many have been at it for generations, and few are easy to find.', '日本の食は、静かなつながりによってつくられています。蔵元、農家、塩づくり、製油所、山の草木を採る人。その多くは小さく、何代にもわたって続いていて、そして見つけにくい。')}</p>
<p>${T('Cabi & Friends maps that network, prefecture by prefecture: the people we work with, the places they come from, and the foods each region is known for.', 'Cabi & Friendsは、そのつながりを都道府県ごとに地図にしています。私たちがともに仕事をする人、その人たちが暮らす土地、そしてそれぞれの地域を代表する食べ物。')}</p>
<p>${T('And we are bringing it beyond Japan. These food traditions deserve to be known, and tasted, by people everywhere.', 'そして私たちは、このつながりを日本の外へ届けています。土地に根づいた食の伝統を、世界中の人に知ってもらい、味わってもらいたいから。')}</p>
<p>${T('Cabi & Friends is part of <a href="https://cabifoods.com">Cabi Foods</a>.', 'Cabi & Friendsは<a href="https://cabifoods.com">Cabi Foods</a>の一部です。')}</p>`,
    };
  } else if (r === 'submit') {
    page = {
      path: '/submit',
      title: T(`Get in touch · ${BRAND}`, `お問い合わせ · ${BRAND}`),
      desc: T('Visiting Japan and want to meet the makers? Email hi@cabifoods.com. Producers and makers can apply to be listed on Cabi & Friends.',
        '日本を訪れて、つくり手に会ってみたい方は hi@cabifoods.com へ。生産者・つくり手の方は、Cabi & Friendsへの掲載をお申し込みいただけます。'),
      ld: [crumbs([[BRAND, '/'], [T('Get in touch', 'お問い合わせ'), '/submit']])],
      body: `<h1>${T('Get in touch', 'お問い合わせ')}</h1>
<h2>${T('Visiting Japan? Want to meet the makers?', '日本を訪れる方へ')}</h2><p>${T('Tell us where you’re headed and what you’d love to taste, and we’ll point you to the right producers:', '行き先や味わってみたいものを教えていただければ、ぴったりのつくり手をご紹介します：')} <a href="mailto:hi@cabifoods.com">hi@cabifoods.com</a></p>
<h2>${T('Want to be listed?', '掲載を希望する方へ')}</h2><p>${T('Producers, farmers, makers and anyone else involved in Japanese food culture can apply to Cabi & Friends. There is no fee to be listed.', '生産者、農家、つくり手、日本の食文化に関わるすべての方が応募できます。掲載は無料です。')}</p>`,
    };
  } else if (r === 'friend' && F[a]) {
    const f = F[a], p = P[f.prefecture];
    const city = f.city && f.city !== p.name_en && !p.name_ja.startsWith(f.city) ? tr(f.city) : '';
    const desc = fDesc(f) || T(`${f.name_en} makes ${f.makes} in ${city ? city + ', ' : ''}${p.name_en}, Japan.`, `${p.name_ja}で${trList(f.makes)}をつくる${fName(f)}。`);
    const photos = f.images.map((im) => ({ url: imgUrl(im.src), alt: im.caption || f.name_en })).filter((x) => x.url);
    const story = (J && f.story_ja?.length ? f.story_ja : f.story) || [];
    const same = FRIENDS.filter((o) => o.prefecture === f.prefecture && o.slug !== f.slug);
    const web = f.website ? 'https://' + f.website : '', ig = f.instagram ? 'https://www.instagram.com/' + f.instagram.replace(/^@/, '') : '';
    page = {
      path: '/friend/' + f.slug,
      title: J ? `${fName(f)} · ${p.name_ja}の${trList(f.makes)} · ${BRAND}` : `${f.name_en}${f.name_ja ? ` (${f.name_ja})` : ''} · ${f.makes} in ${p.name_en}, Japan · ${BRAND}`,
      desc: clip(desc),
      image: photos[0] && { url: photos[0].url, alt: photos[0].alt },
      type: 'profile',
      ld: [
        { '@context': 'https://schema.org', '@type': 'Organization', name: f.name_en, ...(f.name_ja ? { alternateName: f.name_ja } : {}), description: desc,
          url: site + L('/friend/' + f.slug), ...(photos[0] ? { image: photos.slice(0, 3).map((x) => x.url) } : {}),
          ...(web || ig ? { sameAs: [web, ig].filter(Boolean) } : {}), ...(f.makes ? { knowsAbout: f.makes.split(' · ') } : {}),
          address: { '@type': 'PostalAddress', ...(f.city ? { addressLocality: f.city } : {}), addressRegion: p.name_en, addressCountry: 'JP' } },
        crumbs([[BRAND, '/'], [pName(p), '/pref/' + p.slug], [fName(f), '/friend/' + f.slug]]),
      ],
      body: `<h1>${esc(fName(f))}</h1>${!J && f.name_ja ? `<p lang="ja">${esc(f.name_ja)}</p>` : J && f.name_ja ? `<p lang="en">${esc(f.name_en)}</p>` : ''}
<p>${esc(trList(f.makes))} · ${city ? esc(city) + ', ' : ''}<a href="${L('/pref/' + p.slug)}">${esc(pName(p))}</a></p>
${desc ? `<p>${esc(desc)}</p>` : ''}${story.map((s) => `<p>${esc(s)}</p>`).join('')}
${web ? `<p><a href="${esc(web)}" rel="noopener">${esc(f.website)}</a></p>` : ''}${ig ? `<p><a href="${esc(ig)}" rel="noopener">${esc(f.instagram)}</a></p>` : ''}
${photos.slice(0, 3).map((x) => `<img src="${esc(x.url)}" alt="${esc(x.alt)}" width="600" loading="lazy">`).join('')}
${same.length ? `<h2>${T('More Friends in ' + p.name_en, p.name_ja + 'の友人')}</h2><ul>${same.map(friendLi).join('')}</ul>` : ''}
<p><a href="${L('/pref/' + p.slug)}">${T(p.name_en + ' food guide', p.name_ja + 'の食ガイド')}</a> · <a href="${L('/')}">${T('All Friends', '友人一覧')}</a></p>`,
    };
  } else if ((r === 'pref' || r === 'map') && P[a]) {
    const p = P[a], fr = FRIENDS.filter((f) => f.prefecture === p.slug);
    const known = p.specialties.map(tr), seas = p.seasonal_foods.map(tr);
    page = {
      path: '/pref/' + p.slug,
      title: J ? `${p.name_ja}の食ガイド・名産と旬 · ${BRAND}` : `${p.name_en} food guide: what to eat in ${p.name_en} · ${BRAND}`,
      desc: clip(`${pDesc(p)} ${T('Known for', '名産：')}${T(': ', '')}${known.slice(0, 5).join(T(', ', '、'))}${T('.', '。')}`),
      ld: [{ '@context': 'https://schema.org', '@type': 'Place', name: p.name_en, alternateName: p.name_ja, description: p.description, url: site + L('/pref/' + p.slug),
        containedInPlace: { '@type': 'Country', name: 'Japan' } }, crumbs([[BRAND, '/'], [T('Map', '地図'), '/map'], [pName(p), '/pref/' + p.slug]])],
      body: `<h1>${T(p.name_en + ' food guide', p.name_ja + 'の食ガイド')}</h1><p>${esc(pDesc(p))}</p>
<h2>${T('Known for', '名産')}</h2><ul>${known.map((k) => `<li>${esc(k)}</li>`).join('')}</ul>
<h2>${T('In season', '旬')}</h2><ul>${seas.map((s, i) => `<li>${SEASONS[lang][i] || ''}: ${esc(s)}</li>`).join('')}</ul>
${fr.length ? `<h2>${T('Cabi’s Friends in ' + p.name_en, p.name_ja + 'の友人')}</h2><ul>${fr.map(friendLi).join('')}</ul>` : ''}
<p><a href="${L('/map')}">${T('Map of all 47 prefectures', '47都道府県の地図')}</a></p>`,
    };
  } else {
    page = { status: 404, noindex: true, path: pathname, title: T(`Page not found · ${BRAND}`, `ページが見つかりません · ${BRAND}`), desc: '',
      body: `<h1>${T('We couldn’t find that page.', 'ページが見つかりませんでした。')}</h1><p><a href="${L('/')}">${T('Back to the directory', '一覧に戻る')}</a></p>` };
  }

  const canonical = site + L(page.path);
  const alt = (lg) => site + page.path + (lg === 'ja' ? (page.path.includes('?') ? '&' : '?') + 'lang=ja' : '');
  const img = page.image || { url: site + DEFAULT_IMAGE.path, alt: DEFAULT_IMAGE.alt, w: DEFAULT_IMAGE.w, h: DEFAULT_IMAGE.h };
  const robots = page.noindex || !production ? '<meta name="robots" content="noindex, nofollow">\n' : '';
  const ga = /^G-[A-Z0-9]+$/.test(gaId) ? `<script async src="https://www.googletagmanager.com/gtag/js?id=${gaId}"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${gaId}');</script>\n` : '';
  const head = `<title>${esc(page.title)}</title>
<meta name="description" content="${esc(page.desc)}">
${robots}<link rel="canonical" href="${esc(canonical)}">
${page.status === 404 ? '' : `<link rel="alternate" hreflang="en" href="${esc(alt('en'))}">
<link rel="alternate" hreflang="ja" href="${esc(alt('ja'))}">
<link rel="alternate" hreflang="x-default" href="${esc(alt('en'))}">
`}<link rel="icon" type="image/png" href="/assets/favicon.png">
<link rel="apple-touch-icon" href="/assets/apple-touch-icon.png">
<meta property="og:type" content="${page.type || 'website'}">
<meta property="og:site_name" content="${BRAND}">
<meta property="og:locale" content="${J ? 'ja_JP' : 'en_US'}">
<meta property="og:locale:alternate" content="${J ? 'en_US' : 'ja_JP'}">
<meta property="og:title" content="${esc(page.title)}">
<meta property="og:description" content="${esc(page.desc)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:image" content="${esc(img.url)}">
${img.w ? `<meta property="og:image:width" content="${img.w}">\n<meta property="og:image:height" content="${img.h}">\n` : ''}<meta property="og:image:alt" content="${esc(img.alt)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(page.title)}">
<meta name="twitter:description" content="${esc(page.desc)}">
<meta name="twitter:image" content="${esc(img.url)}">
${(page.ld || []).map((o) => `<script type="application/ld+json">${json(o)}</script>`).join('\n')}
${ga}`;

  let html = shell.replace(/<html lang="[^"]*">/, `<html lang="${lang}">`);
  html = html.replace(/<!--seo[\s\S]*?<!--\/seo-->\n?/, `<!--seo-->\n${head}<!--/seo-->\n`);
  html = html.replace('<main id="root"></main>', `<main id="root"><div class="ssr">\n${page.body}\n</div></main>`);
  return { status: page.status || 200, html };
}
