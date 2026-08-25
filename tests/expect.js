/* What each saved page must and must not produce.

   `mustContain` phrases are article prose taken from the middle and the end of each
   piece. They catch the failure that matters most: a scoring pass that latches onto
   one column and silently truncates the article.

   `mustNotContain` phrases are the page's own furniture — newsletter cards, follow
   prompts, related-story rails, sponsor blocks, author bios, nav labels. A phrase
   only counts as leaked when it lands in the reading flow; a block the extractor
   marked as an aside has been filtered, and is not a failure.

   Phrases are matched case-insensitively against the extracted text, and are kept
   short enough to survive the smart quotes and mojibake a saved page carries. */

export const FIXTURES = [
  {
    file: 'guardian-article.html',
    url: 'https://www.theguardian.com/environment/2026/aug/09/falkland-islands-referendum-salmon-farm',
    mustContain: [
      'carrying capacity has not yet been determined',
      'Blue Marine Foundation',
      'rockhopper penguin',
      'socioeconomic impacts',
    ],
    mustNotContain: [
      'Prefer the Guardian on Google',
      'Original reporting and incisive analysis',
      'Crabs, kelp and mussels',
      'All rights reserved',
    ],
  },
  {
    file: 'bbc-article.html',
    url: 'https://www.bbc.co.uk/news/articles/gta6-leaks',
    mustContain: [
      'keep things under wraps as well as they do',
      'Wesley Yin-Poole',
      'huge amount of scepticism',
    ],
    mustNotContain: [
      'Add Ludwig to your Watchlist',
      'The BBC is not responsible for the content of external sites',
    ],
  },
  {
    file: 'npr-article.html',
    url: 'https://www.npr.org/2026/08/21/google-ai-satellite-images',
    mustContain: [
      'Kharg Island',
      'safe bet when it comes to verifying an event',
      'SynthID',
    ],
    mustNotContain: [
      'Expand/collapse submenu',
      'Keyboard shortcuts for audio player',
      'How governments have tried to hide information',
    ],
  },
  {
    file: 'theverge-article.html',
    url: 'https://www.theverge.com/tech/nvidia-financial-strategy',
    mustContain: [
      'mortgage-backed securities market in the 1970s',
      'memorandums of understanding',
      'depreciation',
      'Only the British fleet stands before him',
    ],
    mustNotContain: [
      'will be added to your daily email digest',
      'Getting the conversation ready',
    ],
  },
  {
    file: 'arstechnica-article.html',
    url: 'https://arstechnica.com/cars/2026/08/chinese-regulators-tell-tesla-to-fix-nearly-3-million-cars',
    mustContain: [
      'warning labels',
      'driver monitoring system',
      'Electrek',
    ],
    mustNotContain: [
      'separating the signal from',
      'Automotive Editor at Ars Technica',
      'GrapheneOS phones will launch in 2027',
    ],
  },
  {
    file: 'nature-article.html',
    url: 'https://www.nature.com/articles/d41586-024-00189-3',
    mustContain: ['Sleeper agents', 'deliberately decep'],
    mustNotContain: ['Sign up for the Nature Briefing'],
  },
  {
    file: 'substack-post.html',
    url: 'https://www.astralcodexten.com/p/college-ea-meetups-everywhere',
    mustContain: [
      'volunteer to host meetups',
      'September 7th through October 31st',
      'How do I know if I would be a good meetup organizer',
    ],
    mustNotContain: ['Read distraction-free on Substack'],
  },
  {
    file: 'ghost-cloudflare.html',
    url: 'https://blog.cloudflare.com/bot-preference-sync/',
    mustContain: [
      'Bot Preference Sync',
      'mixed-use crawlers',
      'existing Disallow directives are maintained',
    ],
    mustNotContain: ['Automatic Platform Optimization', 'Digital Experience Monitoring'],
  },
  {
    file: 'simonwillison-blog.html',
    url: 'https://simonwillison.net/2025/Jun/6/six-months-in-llms/',
    mustContain: [
      'pelican riding a bicycle',
      'Llama 3.3 70B',
      'SVG is code',
    ],
    mustNotContain: ['Teleport explains how to deploy AI safely'],
  },
  {
    file: 'wordpress-post.html',
    url: 'https://stratechery.com/2024/the-gen-ai-bridge-to-the-future/',
    mustContain: ['ENIAC', 'generative AI'],
    mustNotContain: ['Explore all free articles on Stratechery'],
  },
  {
    file: 'medium-post.html',
    url: 'https://medium.com/@karpathy/software-2-0-a64152b37c35',
    mustContain: ['neural network'],
    mustNotContain: [],
  },
  {
    file: 'wikipedia-grid-storage.html',
    url: 'https://en.wikipedia.org/wiki/Grid_energy_storage',
    mustContain: [
      'pumped',
      'Grid energy storage',
    ],
    mustNotContain: [
      'This page was last edited on',
      'If Wikipedia is useful to you, please give today',
      'Privacy policy',
    ],
  },
  {
    file: 'mdn-flexbox.html',
    url: 'https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_flexible_box_layout/Basic_concepts_of_flexbox',
    mustContain: ['flex-direction', 'main axis'],
    mustNotContain: ['Skip to main content', 'Community Participation Guidelines'],
  },
  {
    file: 'mdn-grid.html',
    url: 'https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_grid_layout/Basic_concepts_of_grid_layout',
    mustContain: ['grid-template-columns', 'grid container'],
    mustNotContain: ['Skip to main content'],
  },
  {
    file: 'github-readme.html',
    url: 'https://github.com/mozilla/readability',
    mustContain: ['Readability'],
    mustNotContain: ['Do not share my personal information'],
  },
];
