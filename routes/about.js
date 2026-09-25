'use strict';
// ABOUT: GET /about — long-form SEO / AEO / GEO content page with FAQ + Organization + AboutPage JSON-LD.
const express = require('express');
const C = require('../lib/constants');

const router = express.Router();

// Role-based pricing (client decision 2026-09-09): employers $14.99, third party consultants $9.99, + 5% GST. Source: lib/constants.
const dollars = (c) => '$' + (c / 100).toFixed(2);
const gstOf = (c) => Math.round(c * C.PRICING.gst_rate);
const rate = (role) => { const base = C.priceCentsFor(role); return { cents: base, base: dollars(base), gst: dollars(gstOf(base)), total: dollars(base + gstOf(base)), totalCents: base + gstOf(base) }; };
const EMP = rate('employer');
const CON = rate('consultant');
const PRICE = EMP.base, GST = EMP.gst, TOTAL = EMP.total;          // employer rate — the headline price everywhere on this page

// "Quick answers" — short, quotable answers for answer engines. Rendered near the top of the page.
const QUICK_ANSWERS = [
  { q: 'What is Youth Careers Canada?', a: 'Youth Careers Canada is a Canadian job bank for young people — students, interns, graduates, early-career candidates and skilled young professionals — at every stage of building a career in Canada. Employers and third-party consultants post jobs; job seekers search, apply online and receive matched job alerts.' },
  { q: 'Who can post jobs on Youth Careers Canada?', a: 'Any Canadian employer can post directly, and third-party consultants (recruiters, staffing agencies and HR consultants) can post on behalf of the many employers they represent from one account.' },
  { q: 'How much does a job posting cost?', a: `Employers pay ${EMP.base} CAD per posting per month plus GST (${EMP.total} with 5% GST); third-party consultants pay ${CON.base} per posting per month plus GST (${CON.total}). Billed monthly until you cancel.` },
  { q: 'What does a job posting on Youth Careers Canada include?', a: 'Every posting carries at least one full work address (street, city, province and postal code — several addresses on one posting are allowed), the employer’s operating name shown to job seekers, salary with its pay period, education and experience levels, an industry category and an optional NOC code.' },
  { q: 'Is Youth Careers Canada free for job seekers?', a: 'Yes. Job seekers sign up free, upload a resume, apply online and receive job alerts at no cost — there are no paid tiers for candidates.' },
  { q: 'How do job alerts work?', a: 'When a new job is published, Youth Careers Canada compares it with each job seeker’s profile — category, province, city, work arrangement and experience — and emails matching candidates, on the frequency they choose.' },
  { q: 'Who does Youth Careers Canada serve?', a: 'Young people building a career in Canada, at any stage — students, interns and co-op candidates, new graduates, early-career and junior candidates, and skilled young professionals with real experience already behind them — in all 13 Canadian provinces and territories.' },
];

// The FAQ. Rendered as native <details> accordions AND mirrored exactly into FAQPage JSON-LD.
// `more` is an optional follow-up link shown after the answer (not part of the schema text).
const FAQ = [
  { q: 'How much does it cost to post a job on Youth Careers Canada?',
    a: `Employers pay ${EMP.base} CAD per posting per month plus 5% GST (${EMP.gst}), for a total of ${EMP.total} CAD per posting per month. Third-party consultants posting on behalf of clients pay ${CON.base} plus 5% GST (${CON.gst}), for a total of ${CON.total}. The rate is set by the account that pays. There are no setup fees, no per-applicant fees and no contracts.`,
    more: { href: '/employer#pricing', label: 'See employer pricing' } },
  { q: 'Does the price include GST?',
    a: `The advertised prices of ${EMP.base} (employers) and ${CON.base} (third-party consultants) are before tax. GST at 5% is added at checkout, so employers pay ${EMP.total} and consultants ${CON.total} CAD per posting per month, and every payment comes with a numbered receipt you can view or download as a PDF from Billing at any time.` },
  { q: 'Does a job posting need a full work address?',
    a: 'Yes. Every posting created on Youth Careers Canada needs at least one complete work location — street address, city, province and postal code — and a posting may list several addresses when the job is offered at more than one site. Job seekers see each address in full on the posting, Job Bank style. The employer’s operating (trade) name is shown first, with the legal company name beneath it.',
    more: { href: '/employer', label: 'See what a posting needs' } },
  { q: 'How does monthly renewal work, and can I cancel?',
    a: 'A posting renews automatically every month until you cancel it. You can cancel at any time from your dashboard: choose to keep the job live until the end of the current paid period, or take it down immediately. There is no cancellation fee.' },
  { q: 'What happens to a job posting when it expires, is cancelled or is paused?',
    a: 'Expired, cancelled and inactive (paused) postings are archived: they disappear from search results, job alerts, the sitemap and their public page, but the posting and its applicants stay in your dashboard so you can review applications or duplicate the job and post it again.' },
  { q: 'Can a third-party consultant or recruiter post jobs for multiple employers?',
    a: `Yes. A third-party consultant account can hold many employer profiles — one for each client company — and post, manage and renew jobs for all of them from a single sign-in. Each posting is billed at the consultant rate of ${CON.base} plus GST (${CON.total}) per month, with one list of receipts across every client.`,
    more: { href: '/consultant', label: 'Learn about consultant accounts' } },
  { q: 'Is Youth Careers Canada free for job seekers?',
    a: 'Yes. Creating a job seeker profile, uploading a resume, applying to jobs, saving jobs and receiving job alerts are all free. Job seekers are never charged.',
    more: { href: '/jobseeker', label: 'Create a free job seeker profile' } },
  { q: 'What resume formats can I upload?',
    a: 'You can upload a resume as a PDF, Word document (.doc) or Word Open XML document (.docx) up to 5 MB. Your resume is stored securely and shared only with the employer or consultant behind a job you choose to apply to.' },
  { q: 'How are job alerts matched to my profile?',
    a: 'Job alerts use the preferences in your profile — categories, province and city, job type, work arrangement, experience level and the audiences you identify with. When a newly published job matches, we email you on the schedule you choose and show the match on your dashboard.' },
  { q: 'Which parts of Canada does Youth Careers Canada cover?',
    a: 'All 13 provinces and territories, from Ontario, British Columbia, Alberta and Quebec to Nunavut. You can search by province and by city, including Toronto, Vancouver, Calgary, Montreal, Edmonton, Ottawa, Winnipeg and Halifax.',
    more: { href: '/jobs', label: 'Search jobs by province' } },
  { q: 'Is Youth Careers Canada accessible?',
    a: 'Youth Careers Canada is designed with the Web Content Accessibility Guidelines (WCAG) in mind: semantic headings, keyboard navigation, visible focus states, labelled form fields and sufficient colour contrast, on every screen size. If something gets in your way, please tell us so we can fix it.',
    more: { href: '/contact', label: 'Report an accessibility issue' } },
  { q: 'How is my personal information protected?',
    a: 'We handle personal information in line with Canada’s Personal Information Protection and Electronic Documents Act (PIPEDA). We collect only what is needed to run the job bank, resumes are served only through authorised, logged-in routes, and you can update or delete your account information at any time.',
    more: { href: '/privacy', label: 'Read the privacy policy' } },
  { q: 'How do I contact Youth Careers Canada?',
    a: 'Use the contact form to reach the Youth Careers Canada team about a job posting, billing, your account or a technical issue. We reply by email.',
    more: { href: '/contact', label: 'Contact us' } },
];

// "Need to know" FAQ groups — presentation only (which of the *existing* FAQ questions, by index, sits under
// which category heading). The FAQ content/order above is never touched; this only groups it for display.
const FAQ_GROUPS = [
  { label: 'About Youth Careers', indices: [0, 1, 9] },
  { label: "Who it's for", indices: [5, 6] },
  { label: 'How it works', indices: [2, 3, 4, 7, 8] },
  { label: 'Privacy & support', indices: [10, 11, 12] },
];

// Example cities per province, used for the "where we serve" links.
const CITIES = [
  ['Toronto', 'ON'], ['Vancouver', 'BC'], ['Calgary', 'AB'], ['Montreal', 'QC'],
  ['Edmonton', 'AB'], ['Ottawa', 'ON'], ['Winnipeg', 'MB'], ['Halifax', 'NS'],
];

const KNOWS_ABOUT = [
  'Canadian job bank', 'Jobs in Canada', 'Job postings for Canadian employers', 'Third-party recruiter job posting',
  'Jobs in Canada for new immigrants', 'Indigenous employment opportunities in Canada', 'Refugee employment in Canada',
  'Youth jobs in Canada', 'Job alerts', 'Resume upload and online job applications', 'Employment in Ontario',
  'Employment in British Columbia', 'Employment in Alberta', 'Employment in Quebec',
];

const offer = (name, description, cents, url) => ({
  '@type': 'Offer',
  name, description,
  price: (cents / 100).toFixed(2),
  priceCurrency: C.PRICING.currency,
  priceSpecification: {
    '@type': 'UnitPriceSpecification',
    price: (cents / 100).toFixed(2),
    priceCurrency: C.PRICING.currency,
    valueAddedTaxIncluded: false,
    billingIncrement: 1,
    unitCode: 'MON',
    referenceQuantity: { '@type': 'QuantitativeValue', value: 1, unitCode: 'MON' },
  },
  availability: 'https://schema.org/InStock',
  url,
});

function buildJsonLd(PUBLIC_URL) {
  const url = `${PUBLIC_URL}/about`;
  const orgId = `${PUBLIC_URL}/#organization`;
  const siteId = `${PUBLIC_URL}/#website`;
  const organization = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    '@id': orgId,
    name: 'Youth Careers Canada',
    alternateName: 'Youth Careers Canada Job Bank',
    url: PUBLIC_URL,
    logo: `${PUBLIC_URL}/img/logo-stacked.svg`,
    slogan: 'Our dreams. Our skills. Our future. Our Canada.',
    description: `Youth Careers Canada is a Canadian job bank for young people building a career in Canada. Employers post jobs for ${EMP.base} + GST per posting per month, third-party consultants for ${CON.base} + GST, and job seekers — students, graduates and early-career to skilled young professionals — search, apply online and receive matched job alerts free of charge.`,
    sameAs: [],
    areaServed: { '@type': 'Country', name: 'Canada' },
    knowsAbout: KNOWS_ABOUT,
    contactPoint: [{
      '@type': 'ContactPoint',
      contactType: 'customer support',
      url: `${PUBLIC_URL}/contact`,
      areaServed: 'CA',
      availableLanguage: ['English'],
    }],
    makesOffer: [
      offer('Job posting on Youth Careers Canada — employer', 'One job posting by an employer on Youth Careers Canada, renewed monthly until cancelled. GST is added at checkout.', EMP.cents, `${PUBLIC_URL}/employer`),
      offer('Job posting on Youth Careers Canada — third party consultant', 'One job posting by a third-party consultant on behalf of a client, renewed monthly until cancelled. GST is added at checkout.', CON.cents, `${PUBLIC_URL}/consultant`),
    ],
  };
  const website = {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    '@id': siteId,
    name: 'Youth Careers Canada',
    url: PUBLIC_URL,
    publisher: { '@id': orgId },
    inLanguage: 'en-CA',
    potentialAction: {
      '@type': 'SearchAction',
      target: { '@type': 'EntryPoint', urlTemplate: `${PUBLIC_URL}/jobs?q={search_term_string}` },
      'query-input': 'required name=search_term_string',
    },
  };
  const breadcrumb = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    '@id': `${url}#breadcrumb`,
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: PUBLIC_URL + '/' },
      { '@type': 'ListItem', position: 2, name: 'About Us', item: url },
    ],
  };
  const aboutPage = {
    '@context': 'https://schema.org',
    '@type': ['WebPage', 'AboutPage'],
    '@id': `${url}#webpage`,
    url,
    name: 'About Youth Careers Canada — careers in Canada for young talent everywhere',
    description: 'Who Youth Careers Canada is, who it serves, what a job posting costs and how job seekers use it free.',
    inLanguage: 'en-CA',
    isPartOf: { '@id': siteId },
    about: { '@id': orgId },
    mainEntity: { '@id': orgId },
    breadcrumb: { '@id': `${url}#breadcrumb` },
    primaryImageOfPage: { '@type': 'ImageObject', url: `${PUBLIC_URL}/img/og.png` },
    speakable: { '@type': 'SpeakableSpecification', cssSelector: ['.about-quick'] },
  };
  const faqPage = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    '@id': `${url}#faq`,
    mainEntity: FAQ.map(({ q, a }) => ({
      '@type': 'Question',
      name: q,
      acceptedAnswer: { '@type': 'Answer', text: a },
    })),
  };
  return [organization, website, aboutPage, breadcrumb, faqPage];
}

router.get('/about', (req, res) => {
  const PUBLIC_URL = res.locals.PUBLIC_URL;
  res.render('about/about', {
    title: 'About Us — careers in Canada for young talent',
    metaDescription: `Youth Careers Canada is a Canadian job bank for young people at every career stage: employers post jobs for ${EMP.base} + GST a month, consultants for ${CON.base} + GST; job seekers apply free with matched alerts.`,
    extraCss: ['/css/about.css', '/css/landing.css'],
    jsonLd: buildJsonLd(PUBLIC_URL),
    bodyClass: 'page-about',
    quick: QUICK_ANSWERS,
    faq: FAQ,
    faqGroups: FAQ_GROUPS,
    cities: CITIES,
    price: { base: PRICE, gst: GST, total: TOTAL, employer: EMP, consultant: CON },
  });
});

module.exports = router;
