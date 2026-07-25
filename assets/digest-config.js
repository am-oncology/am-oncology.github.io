/* ============================================================
   digest-config.js — every literature digest, defined as data.

   This replaces cns-digest.html, crc-digest.html and
   cxb-digest.html. All three were the same page with a different
   search string; they are now three entries below, and CXB has
   become a tab within the lower GI set rather than its own page.

   To add a subspecialty: add a key to SETS. To add a tab: add an
   object to that set's `tabs`. No HTML or JS needs to change.
   ============================================================ */
window.DIGEST_SETS = {

  cns: {
    title: 'Neuro-oncology digest',
    subtitle: 'Recent literature · brain, skull base and ocular tumours',
    accent: '#0284C7',
    highImpact: [
      'N Engl J Med', 'Lancet', 'Lancet Oncol', 'J Clin Oncol', 'Neuro Oncol',
      'JAMA', 'JAMA Oncol', 'Nat Med', 'Cancer Cell', 'J Neurosurg',
      'Int J Radiat Oncol Biol Phys', 'Radiother Oncol', 'Acta Neuropathol',
      'Brain', 'Neurology', 'Clin Cancer Res'
    ],
    tabs: [
      {
        id: 'glioma',
        label: 'Glioma',
        accent: '#0284C7',
        query: '(glioblastoma[tiab] OR glioma[tiab] OR astrocytoma[tiab] OR oligodendroglioma[tiab] OR "diffuse midline glioma"[tiab] OR ependymoma[tiab]) AND "humans"[MeSH Terms]'
      },
      {
        id: 'skullbase',
        label: 'Skull base',
        accent: '#0D9488',
        query: '(meningioma[tiab] OR "vestibular schwannoma"[tiab] OR "acoustic neuroma"[tiab] OR "skull base"[tiab] OR PitNET[tiab] OR "pituitary adenoma"[tiab] OR chordoma[tiab] OR "glomus jugulare"[tiab]) AND "humans"[MeSH Terms]'
      },
      {
        id: 'srs',
        label: 'SRS / SABR',
        accent: '#4338CA',
        query: '("stereotactic radiosurgery"[tiab] OR SRS[tiab] OR SRT[tiab] OR fSRT[tiab] OR SBRT[tiab] OR SABR[tiab] OR "gamma knife"[tiab] OR cyberknife[tiab] OR "ZAP-X"[tiab] OR hyperarc[tiab] OR Novalis[tiab]) AND (brain[tiab] OR spine[tiab] OR spinal[tiab] OR intracranial[tiab] OR meningioma[tiab] OR schwannoma[tiab] OR metasta*[tiab] OR AVM[tiab] OR "trigeminal neuralgia"[tiab]) AND ("humans"[MeSH Terms] OR human[tiab])'
      },
      {
        id: 'brainmets',
        label: 'Brain metastases',
        accent: '#7C3AED',
        query: '("brain metastases"[tiab] OR "brain metastasis"[tiab] OR "leptomeningeal"[tiab] OR "cerebral metastases"[tiab]) AND (radiotherapy[tiab] OR radiosurgery[tiab] OR "whole brain"[tiab] OR hippocamp*[tiab] OR systemic[tiab]) AND "humans"[MeSH Terms]'
      },
      {
        id: 'ocular',
        label: 'Ocular / orbital',
        accent: '#2563EB',
        query: '("uveal melanoma"[tiab] OR "choroidal melanoma"[tiab] OR "conjunctival melanoma"[tiab] OR retinoblastoma[tiab] OR "thyroid eye disease"[tiab] OR "Graves orbitopathy"[tiab] OR "Graves ophthalmopathy"[tiab] OR "orbital lymphoma"[tiab] OR "adnexal lymphoma"[tiab] OR "orbital pseudotumor"[tiab] OR "idiopathic orbital inflammation"[tiab] OR "choroidal hemangioma"[tiab] OR pterygium[tiab] OR "optic nerve sheath meningioma"[tiab] OR ONSM[tiab]) AND (radiotherapy[tiab] OR radiation[tiab] OR brachytherapy[tiab] OR plaque[tiab] OR "proton beam"[tiab] OR SBRT[tiab]) AND ("humans"[MeSH Terms] OR human[tiab])'
      }
    ]
  },

  crc: {
    title: 'Lower GI digest',
    subtitle: 'Recent literature · colorectal, anal and appendiceal cancer',
    accent: '#7C3AED',
    highImpact: [
      'N Engl J Med', 'Lancet', 'Lancet Oncol', 'Lancet Gastroenterol Hepatol',
      'J Clin Oncol', 'JAMA', 'JAMA Oncol', 'Ann Oncol', 'Nat Med',
      'Int J Radiat Oncol Biol Phys', 'Radiother Oncol', 'Clin Oncol',
      'Dis Colon Rectum', 'Colorectal Dis', 'Br J Surg', 'Ann Surg',
      'Gastroenterology', 'Gut', 'Br J Cancer'
    ],
    tabs: [
      {
        id: 'rectal',
        label: 'Rectal',
        accent: '#0284C7',
        query: '("rectal neoplasms"[MeSH Terms] OR "rectal cancer"[tiab] OR "rectal carcinoma"[tiab] OR "total neoadjuvant"[tiab] OR "watch and wait"[tiab]) AND ("humans"[MeSH Terms] OR human[tiab])'
      },
      {
        id: 'colon',
        label: 'Colon',
        accent: '#7C3AED',
        query: '("colonic neoplasms"[MeSH Terms] OR "colon cancer"[tiab] OR "colon carcinoma"[tiab] OR "colorectal cancer"[tiab]) AND ("humans"[MeSH Terms] OR human[tiab])'
      },
      {
        id: 'anal',
        label: 'Anal',
        accent: '#059669',
        query: '("anus neoplasms"[MeSH Terms] OR "anal cancer"[tiab] OR "anal carcinoma"[tiab] OR "anal squamous"[tiab]) AND ("humans"[MeSH Terms] OR human[tiab])'
      },
      {
        id: 'appendix',
        label: 'Appendiceal',
        accent: '#DB2777',
        query: '("appendiceal neoplasms"[MeSH Terms] OR "appendix cancer"[tiab] OR "appendiceal carcinoma"[tiab] OR pseudomyxoma[tiab]) AND ("humans"[MeSH Terms] OR human[tiab])'
      },
      {
        /* Formerly cxb-digest.html — same query, now a tab. */
        id: 'cxb',
        label: 'Contact XRT (Papillon)',
        accent: '#B45309',
        query: '(Papillon[tiab] OR "contact radiotherapy"[tiab] OR "contact x-ray brachytherapy"[tiab] OR "contact brachytherapy"[tiab] OR "endocavitary brachytherapy"[tiab] OR "organ preservation"[tiab]) AND ("rectal neoplasms"[MeSH Terms] OR "rectal cancer"[tiab] OR rectum[tiab])'
      }
    ]
  }
};

/* Article-type filters, appended to whichever query is active. */
window.DIGEST_TYPES = [
  { label: 'All article types', value: '' },
  { label: 'Randomised trials', value: ' AND "Randomized Controlled Trial"[Publication Type]' },
  { label: 'Clinical trials',   value: ' AND "Clinical Trial"[Publication Type]' },
  { label: 'Meta-analyses',     value: ' AND "Meta-Analysis"[Publication Type]' },
  { label: 'Reviews',           value: ' AND "Review"[Publication Type]' },
  { label: 'Guidelines',        value: ' AND ("Guideline"[Publication Type] OR "Practice Guideline"[Publication Type])' }
];

window.DIGEST_RANGES = [
  { label: '30 days',  value: 30 },
  { label: '90 days',  value: 90, default: true },
  { label: '6 months', value: 180 },
  { label: '1 year',   value: 365 }
];
