'use strict';
// ABOUT: GET /about — long-form SEO / AEO / GEO content page with FAQ + Organization + AboutPage JSON-LD.
const express = require('express');
const C = require('../lib/constants');

const router = express.Router();

const PRICE = '$9.99';
const GST = '$0.50';
const TOTAL = '$10.49';

// "Quick answers" — short, quotable answers for answer engines. Rendered near the top of the page.
const QUICK_ANSWERS = [
  { q: 'What is Canada Careers?', a: 'Canada Careers is a Canadian job bank where employers and third-party consultants post jobs and job seekers across Canada search, apply online and receive matched job alerts — with a focus on professionals, new immigrants, Indigenous peoples, refugees and youth.' },
  { q: 'Who can post jobs on Canada Careers?', a: 'Any Canadian employer can post directly, and third-party consultants (recruiters, staffing agencies and HR consultants) can post on behalf of the many employers they represent from one account.' },
  { q: 'How much does a job posting cost?', a: `A job posting costs ${PRICE} CAD plus GST (${TOTAL} with 5% GST) per posting per month, billed monthly until you cancel.` },
  { q: 'Is Canada Careers free for job seekers?', a: 'Yes. Job seekers sign up free, upload a resume, apply online and receive job alerts at no cost — there are no paid tiers for candidates.' },
  { q: 'How do job alerts work?', a: 'When a new job is published, Canada Careers compares it with each job seeker’s profile — category, province, city, work arrangement, experience and audience — and emails matching candidates, on the frequency they choose.' },
  { q: 'Who does Canada Careers serve?', a: 'Five audiences from our logo: Professionals, New Immigrants, Indigenous peoples, Refugees and Youth — in all 13 Canadian provinces and territories.' },
];

// The FAQ. Rendered as native <details> accordions AND mirrored exactly into FAQPage JSON-LD.
// `more` is an optional follow-up link shown after the answer (not part of the schema text).
const FAQ = [
  { q: 'How much does it cost to post a job on Canada Careers?',
    a: `Each job posting costs ${PRICE} CAD per month plus 5% GST (${GST}), for a total of ${TOTAL} CAD per posting per month. There are no setup fees, no per-applicant fees and no contracts.`,
    more: { href: '/employer#pricing', label: 'See employer pricing' } },
  { q: 'Does the price include GST?',
    a: `The advertised price of ${PRICE} is before tax. GST at 5% is added at checkout, so you pay ${TOTAL} CAD per posting per month, and every payment comes with a numbered receipt for your records.` },
  { q: 'How does monthly renewal work, and can I cancel?',
    a: 'A posting renews automatically every month until you cancel it. You can cancel at any time from your dashboard: choose to keep the job live until the end of the current paid period, or take it down immediately. There is no cancellation fee.' },
  { q: 'What happens to a job posting when it expires, is cancelled or is paused?',
    a: 'Expired, cancelled and inactive (paused) postings are archived. They no longer appear in search results, job alerts, the sitemap or the public job page, but the posting and its applicants stay in your dashboard so you can review applications or duplicate the job and post it again.' },
  { q: 'Can a third-party consultant or recruiter post jobs for multiple employers?',
    a: 'Yes. A third-party consultant account can hold many employer profiles — one for each client company — and post, manage and renew jobs for all of them from a single sign-in. Each posting is billed at the same ' + PRICE + ' plus GST per month.',
    more: { href: '/consultant', label: 'Learn about consultant accounts' } },
  { q: 'Is Canada Careers free for job seekers?',
    a: 'Yes. Creating a job seeker profile, uploading a resume, applying to jobs, saving jobs and receiving job alerts are all free. Job seekers are never charged.',
    more: { href: '/jobseeker', label: 'Create a free job seeker profile' } },
  { q: 'What resume formats can I upload?',
    a: 'You can upload a resume as a PDF, Word document (.doc) or Word Open XML document (.docx) up to 5 MB. Your resume is stored securely and shared only with the employer or consultant behind a job you choose to apply to.' },
  { q: 'How are job alerts matched to my profile?',
    a: 'Job alerts use the preferences in your profile — job categories, province and city, job type, work arrangement, experience level and the audiences you identify with. When a newly published job matches, we notify you by email on the schedule you choose, and the match also appears on your dashboard.' },
  { q: 'Which parts of Canada does Canada Careers cover?',
    a: 'All 13 provinces and territories: Alberta, British Columbia, Manitoba, New Brunswick, Newfoundland and Labrador, Nova Scotia, Northwest Territories, Nunavut, Ontario, Prince Edward Island, Quebec, Saskatchewan and Yukon. You can search by province and by city, including Toronto, Vancouver, Calgary, Montreal, Edmonton, Ottawa, Winnipeg and Halifax.',
    more: { href: '/jobs', label: 'Search jobs by province' } },
  { q: 'Is Canada Careers accessible?',
    a: 'Canada Careers is designed with the Web Content Accessibility Guidelines (WCAG) in mind: semantic headings, keyboard navigation, visible focus states, labelled form fields, sufficient colour contrast and layouts that work from a 390-pixel phone screen up to a desktop. If something gets in your way, please tell us so we can fix it.',
    more: { href: '/contact', label: 'Report an accessibility issue' } },
  { q: 'How is my personal information protected?',
    a: 'We handle personal information in line with Canada’s Personal Information Protection and Electronic Documents Act (PIPEDA). We collect only what is needed to run the job bank, resumes are served only through authorised, logged-in routes, and you can update or delete your account information at any time.',
    more: { href: '/privacy', label: 'Read the privacy policy' } },
  { q: 'How do I contact Canada Careers?',
    a: 'Use the contact form to reach the Canada Careers team about a job posting, billing, your account or a technical issue. We reply by email.',
    more: { href: '/contact', label: 'Contact us' } },
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

function buildJsonLd(PUBLIC_URL) {
  const url = `${PUBLIC_URL}/about`;
  const orgId = `${PUBLIC_URL}/#organization`;
  const siteId = `${PUBLIC_URL}/#website`;
  const organization = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    '@id': orgId,
    name: 'Canada Careers',
    alternateName: 'Canada Careers Job Bank',
    url: PUBLIC_URL,
    logo: `${PUBLIC_URL}/img/logo-stacked.svg`,
    slogan: 'Jobs for every Canadian. Opportunities for all.',
    description: 'Canada Careers is a Canadian job bank where employers and third-party consultants post jobs for $9.99 + GST per posting per month and job seekers — professionals, new immigrants, Indigenous peoples, refugees and youth — search, apply online and receive matched job alerts free of charge.',
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
    makesOffer: {
      '@type': 'Offer',
      name: 'Job posting on Canada Careers',
      description: 'One job posting on Canada Careers, renewed monthly until cancelled. GST is added at checkout.',
      price: (C.PRICING.price_cents / 100).toFixed(2),
      priceCurrency: C.PRICING.currency,
      priceSpecification: {
        '@type': 'UnitPriceSpecification',
        price: (C.PRICING.price_cents / 100).toFixed(2),
        priceCurrency: C.PRICING.currency,
        valueAddedTaxIncluded: false,
        billingIncrement: 1,
        unitCode: 'MON',
        referenceQuantity: { '@type': 'QuantitativeValue', value: 1, unitCode: 'MON' },
      },
      availability: 'https://schema.org/InStock',
      url: `${PUBLIC_URL}/employer`,
    },
  };
  const website = {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    '@id': siteId,
    name: 'Canada Careers',
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
    name: 'About Canada Careers — Canada’s inclusive job bank',
    description: 'Who Canada Careers is, who it serves, what a job posting costs and how job seekers use it free.',
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
    title: 'About Us — Canada’s inclusive job bank',
    metaDescription: `Canada Careers is Canada’s inclusive job bank: employers and consultants post jobs for ${PRICE} + GST a month; job seekers apply free and get matched alerts.`,
    extraCss: ['/css/about.css'],
    jsonLd: buildJsonLd(PUBLIC_URL),
    bodyClass: 'page-about',
    quick: QUICK_ANSWERS,
    faq: FAQ,
    cities: CITIES,
    price: { base: PRICE, gst: GST, total: TOTAL },
  });
});

module.exports = router;
