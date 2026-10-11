// @codedna
// description: Original musical categories and presets from Suno Prompt Master.
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//
// 
//
// 
//
// 
//
// 
//
// 
//
// exports: GENRE_HIERARCHY | VOCAL_HIERARCHY | REFERENCES_BY_ERA | MOOD_OPTIONS | TEMPO_OPTIONS | KEY_OPTIONS | MODES_OPTIONS | STRUCTURE_OPTIONS | INSTRUMENTS_OPTIONS | PRODUCTION_OPTIONS | ERA_OPTIONS | GOAL_OPTIONS | RHYTHM_OPTIONS | GROOVE_FEEL_OPTIONS | BASS_TONE_OPTIONS | HARMONY_FORM_OPTIONS | MELODY_OPTIONS | EAR_CANDY_SPACE_OPTIONS | MIX_MASTER_HIERARCHY | PROMPT_CATEGORIES | (+4 more)
// used_by: sonora-studio/public/prompt-core.mjs
//                   sonora-studio/public/prompt-ui.mjs
// rules:   Imported from the user-owned Suno Prompt source. Preserve original musical choices and conflict rules.
// agent:   Codex - 2026-10-04 - Adapted pure logic without React or site authentication.
export const GENRE_HIERARCHY = [
  {
    id: 'pop',
    name: 'Pop',
    description: 'Modern contemporary pop',
    subOptions: [
      { id: 'pop-main', name: 'Pop' },
      { id: 'indie-pop', name: 'Indie Pop' },
      { id: 'synthpop', name: 'Synthpop' },
      { id: 'electropop', name: 'Electropop' },
      { id: 'dark-pop', name: 'Dark Pop' },
      { id: 'alternative-pop', name: 'Alternative Pop' },
      { id: 'dream-pop', name: 'Dream Pop' },
      { id: 'chamber-pop', name: 'Chamber Pop' },
      { id: 'k-pop', name: 'K-Pop' },
      { id: 'j-pop', name: 'J-Pop' },
      { id: 'bubblegum-pop', name: 'Bubblegum Pop' },
    ],
  },
  {
    id: 'rock',
    name: 'Rock',
    description: 'Rock and alternative',
    subOptions: [
      { id: 'rock-main', name: 'Rock' },
      { id: 'alternative-rock', name: 'Alternative Rock' },
      { id: 'indie-rock', name: 'Indie Rock' },
      { id: 'psychedelic-rock', name: 'Psychedelic Rock' },
      { id: 'post-rock', name: 'Post-Rock' },
      { id: 'grunge', name: 'Grunge' },
      { id: 'punk', name: 'Punk' },
      { id: 'punk-rock', name: 'Punk Rock' },
      { id: 'american-rock', name: 'American Rock' },
      { id: '70s-rock', name: '70s Rock' },
      { id: '80s-rock', name: '80s Rock' },
      { id: '90s-rock', name: '90s Rock' },
      { id: 'rockabilly', name: 'Rockabilly' },
      { id: 'rock-and-roll', name: 'Rock & Roll' },
      { id: 'blues-rock', name: 'Blues Rock' },
      { id: 'garage-rock', name: 'Garage Rock' },
      { id: 'surf-rock', name: 'Surf Rock' },
      { id: 'southern-rock', name: 'Southern Rock' },
    ],
  },
  {
    id: 'metal',
    name: 'Metal',
    description: 'Heavy metal and subgenres',
    subOptions: [
      { id: 'metal-main', name: 'Metal' },
      { id: 'heavy-metal', name: 'Heavy Metal' },
      { id: 'thrash-metal', name: 'Thrash Metal' },
      { id: 'death-metal', name: 'Death Metal' },
      { id: 'black-metal', name: 'Black Metal' },
      { id: 'doom-metal', name: 'Doom Metal' },
      { id: 'nu-metal', name: 'Nu-Metal' },
      { id: 'post-metal', name: 'Post-Metal' },
      { id: 'progressive-metal', name: 'Progressive Metal' },
      { id: 'power-metal', name: 'Power Metal' },
      { id: 'symphonic-metal', name: 'Symphonic Metal' },
    ],
  },
  {
    id: 'hip-hop',
    name: 'Hip-Hop',
    description: 'Hip-hop and rap',
    subOptions: [
      { id: 'hip-hop-main', name: 'Hip-Hop' },
      { id: 'trap', name: 'Trap' },
      { id: 'boom-bap', name: 'Boom Bap' },
      { id: 'cloud-rap', name: 'Cloud Rap' },
      { id: 'lo-fi-hip-hop', name: 'Lo-Fi Hip-Hop' },
      { id: 'drill', name: 'Drill' },
      { id: 'old-school-hip-hop', name: 'Old School Hip-Hop' },
      { id: 'conscious-rap', name: 'Conscious Rap' },
      { id: 'gangsta-rap', name: 'Gangsta Rap' },
      { id: 'phonk', name: 'Phonk' },
    ],
  },
  {
    id: 'rnb-soul',
    name: 'R&B / Soul',
    description: 'Rhythm & Blues and Soul',
    subOptions: [
      { id: 'rnb-main', name: 'R&B' },
      { id: 'soul', name: 'Soul' },
      { id: 'neo-soul', name: 'Neo-Soul' },
      { id: 'funk', name: 'Funk' },
      { id: 'motown', name: 'Motown' },
      { id: 'gospel', name: 'Gospel' },
      { id: 'contemporary-rnb', name: 'Contemporary R&B' },
    ],
  },
  {
    id: 'jazz',
    name: 'Jazz',
    description: 'Jazz and its variants',
    subOptions: [
      { id: 'jazz-main', name: 'Jazz' },
      { id: 'smooth-jazz', name: 'Smooth Jazz' },
      { id: 'bebop', name: 'Bebop' },
      { id: 'swing-jazz', name: 'Swing' },
      { id: 'jazz-fusion', name: 'Jazz Fusion' },
      { id: 'cool-jazz', name: 'Cool Jazz' },
      { id: 'latin-jazz', name: 'Latin Jazz' },
      { id: 'acid-jazz', name: 'Acid Jazz' },
      { id: 'nu-jazz', name: 'Nu-Jazz' },
      { id: 'big-band', name: 'Big Band' },
      { id: 'free-jazz', name: 'Free Jazz' },
    ],
  },
  {
    id: 'blues',
    name: 'Blues',
    description: 'Blues and related styles',
    subOptions: [
      { id: 'blues-main', name: 'Blues' },
      { id: 'delta-blues', name: 'Delta Blues' },
      { id: 'chicago-blues', name: 'Chicago Blues' },
      { id: 'electric-blues', name: 'Electric Blues' },
      { id: 'rhythm-and-blues', name: 'Rhythm & Blues' },
      { id: 'country-blues', name: 'Country Blues' },
    ],
  },
  {
    id: 'dance',
    name: 'Electronic / Dance',
    description: 'Electronic Dance Music',
    subOptions: [
      { id: 'dance-main', name: 'Dance' },
      { id: 'edm', name: 'EDM' },
      { id: 'future-bass', name: 'Future Bass' },
      { id: 'dubstep', name: 'Dubstep' },
      { id: 'drum-step', name: 'Drum Step' },
      { id: 'big-room', name: 'Big Room' },
      { id: 'electro', name: 'Electro' },
      { id: 'electroclash', name: 'Electroclash' },
      { id: 'breakbeat', name: 'Breakbeat' },
    ],
  },
  {
    id: 'house',
    name: 'House',
    description: 'Classic and modern house',
    subOptions: [
      { id: 'house-main', name: 'House' },
      { id: 'deep-house', name: 'Deep House' },
      { id: 'tech-house', name: 'Tech House' },
      { id: 'progressive-house', name: 'Progressive House' },
      { id: 'future-house', name: 'Future House' },
      { id: 'afro-house', name: 'Afro House' },
      { id: 'garage', name: 'UK Garage' },
      { id: 'tribal-house', name: 'Tribal House' },
    ],
  },
  {
    id: 'techno',
    name: 'Techno',
    description: 'Industrial and hypnotic techno',
    subOptions: [
      { id: 'techno-main', name: 'Techno' },
      { id: 'hard-techno', name: 'Hard Techno' },
      { id: 'melodic-techno', name: 'Melodic Techno' },
      { id: 'minimal-techno', name: 'Minimal Techno' },
      { id: 'acid-techno', name: 'Acid Techno' },
      { id: 'industrial-techno', name: 'Industrial Techno' },
      { id: 'detroit-techno', name: 'Detroit Techno' },
    ],
  },
  {
    id: 'trance',
    name: 'Trance',
    description: 'Uplifting and emotional trance',
    subOptions: [
      { id: 'trance-main', name: 'Trance' },
      { id: 'psytrance', name: 'Psytrance' },
      { id: 'vocal-trance', name: 'Vocal Trance' },
      { id: 'progressive-trance', name: 'Progressive Trance' },
      { id: 'uplifting-trance', name: 'Uplifting Trance' },
      { id: 'goa-trance', name: 'Goa Trance' },
      { id: 'dark-psy', name: 'Dark Psy' },
    ],
  },
  {
    id: 'dnb',
    name: 'Drum & Bass',
    description: 'Fast drum and bass',
    subOptions: [
      { id: 'dnb-main', name: 'Drum & Bass' },
      { id: 'liquid-dnb', name: 'Liquid DnB' },
      { id: 'neurofunk', name: 'Neurofunk' },
      { id: 'jump-up', name: 'Jump Up' },
      { id: 'jungle', name: 'Jungle' },
      { id: 'footwork', name: 'Footwork' },
      { id: 'halftime', name: 'Halftime' },
    ],
  },
  {
    id: 'ambient',
    name: 'Ambient / IDM',
    description: 'Ambient, experimental and atmospheric',
    subOptions: [
      { id: 'ambient-main', name: 'Ambient' },
      { id: 'dark-ambient', name: 'Dark Ambient' },
      { id: 'drone', name: 'Drone' },
      { id: 'space-ambient', name: 'Space Ambient' },
      { id: 'idm', name: 'IDM' },
      { id: 'experimental-electronic', name: 'Experimental Electronic' },
      { id: 'noise', name: 'Noise' },
      { id: 'glitch', name: 'Glitch' },
    ],
  },
  {
    id: 'lofi-chill',
    name: 'Lo-Fi / Chill',
    description: 'Relaxed and downtempo vibes',
    subOptions: [
      { id: 'lo-fi-main', name: 'Lo-Fi' },
      { id: 'chillout', name: 'Chillout' },
      { id: 'downtempo', name: 'Downtempo' },
      { id: 'trip-hop', name: 'Trip-Hop' },
      { id: 'chillwave', name: 'Chillwave' },
      { id: 'chillstep', name: 'Chillstep' },
    ],
  },
  {
    id: 'classical',
    name: 'Classical',
    description: 'Classical and academic music',
    subOptions: [
      { id: 'classical-main', name: 'Classical' },
      { id: 'baroque', name: 'Baroque' },
      { id: 'romantic-era', name: 'Romantic Era' },
      { id: 'contemporary-classical', name: 'Contemporary Classical' },
      { id: 'minimalism', name: 'Minimalism' },
      { id: 'neoclassical', name: 'Neoclassical' },
      { id: 'chamber-music', name: 'Chamber Music' },
    ],
  },
  {
    id: 'opera',
    name: 'Opera / Theatrical',
    description: 'Opera, musical theatre and vocal performance',
    subOptions: [
      { id: 'opera-main', name: 'Opera' },
      { id: 'aria', name: 'Aria' },
      { id: 'operatic-pop', name: 'Operatic Pop' },
      { id: 'musical-theatre', name: 'Musical Theatre' },
      { id: 'cabaret', name: 'Cabaret' },
      { id: 'chanson', name: 'Chanson' },
    ],
  },
  {
    id: 'cinematic',
    name: 'Cinematic / Soundtrack',
    description: 'Film, TV and game music',
    subOptions: [
      { id: 'cinematic-main', name: 'Cinematic' },
      { id: 'orchestral', name: 'Orchestral' },
      { id: 'epic-orchestral', name: 'Epic Orchestral' },
      { id: 'dark-cinematic', name: 'Dark Cinematic' },
      { id: 'video-game-ost', name: 'Video Game OST' },
      { id: 'trailer-music', name: 'Trailer Music' },
      { id: 'tv-soundtrack', name: 'TV Soundtrack' },
    ],
  },
  {
    id: 'reggae',
    name: 'Reggae',
    description: 'Reggae and Caribbean rhythms',
    subOptions: [
      { id: 'reggae-main', name: 'Reggae' },
      { id: 'ska', name: 'Ska' },
      { id: 'rocksteady', name: 'Rock Steady' },
      { id: 'dancehall', name: 'Dancehall' },
      { id: 'dub', name: 'Dub' },
      { id: 'roots-reggae', name: 'Roots Reggae' },
    ],
  },
  {
    id: 'latin',
    name: 'Latin',
    description: 'Latin and Caribbean music',
    subOptions: [
      { id: 'latin-pop', name: 'Latin Pop' },
      { id: 'salsa', name: 'Salsa' },
      { id: 'bossa-nova', name: 'Bossa Nova' },
      { id: 'samba', name: 'Samba' },
      { id: 'reggaeton', name: 'Reggaeton' },
      { id: 'cumbia', name: 'Cumbia' },
      { id: 'flamenco', name: 'Flamenco' },
      { id: 'mariachi', name: 'Mariachi' },
      { id: 'tango', name: 'Tango' },
      { id: 'bachata', name: 'Bachata' },
    ],
  },
  {
    id: 'folk-country',
    name: 'Folk / Country',
    description: 'Folk, country and acoustic traditions',
    subOptions: [
      { id: 'folk-main', name: 'Folk' },
      { id: 'country', name: 'Country' },
      { id: 'bluegrass', name: 'Bluegrass' },
      { id: 'americana', name: 'Americana' },
      { id: 'celtic', name: 'Celtic' },
      { id: 'singer-songwriter', name: 'Singer-Songwriter' },
      { id: 'indie-folk', name: 'Indie Folk' },
      { id: 'country-pop', name: 'Country Pop' },
    ],
  },
  {
    id: 'world',
    name: 'World Music',
    description: 'Global and ethnic music',
    subOptions: [
      { id: 'afrobeat', name: 'Afrobeat' },
      { id: 'afropop', name: 'Afropop' },
      { id: 'world-music', name: 'World Music' },
      { id: 'arabic-music', name: 'Arabic Music' },
      { id: 'indian-classical', name: 'Indian Classical' },
      { id: 'bali-gamelan', name: 'Gamelan' },
      { id: 'celtic-folk', name: 'Celtic Folk' },
    ],
  },
];
export const VOCAL_HIERARCHY = [
  {
    id: 'no-vocals',
    name: 'No Vocals',
    description: 'Instrumental only',
    subOptions: [{ id: 'instrumental-only', name: 'Instrumental Only' }],
  },
  {
    id: 'male-voice',
    name: 'Male Voice',
    description: 'Male vocal characteristics',
    subOptions: [
      { id: 'male-warm', name: 'Warm' },
      { id: 'male-deep', name: 'Deep' },
      { id: 'male-breathy', name: 'Breathy' },
      { id: 'male-raspy', name: 'Raspy' },
      { id: 'male-smooth', name: 'Smooth' },
      { id: 'male-powerful', name: 'Powerful' },
      { id: 'male-falsetto', name: 'Falsetto' },
      { id: 'male-husky', name: 'Husky' },
    ],
  },
  {
    id: 'female-voice',
    name: 'Female Voice',
    description: 'Female vocal characteristics',
    subOptions: [
      { id: 'female-warm', name: 'Warm' },
      { id: 'female-ethereal', name: 'Ethereal' },
      { id: 'female-breathy', name: 'Breathy' },
      { id: 'female-raspy', name: 'Raspy' },
      { id: 'female-smooth', name: 'Smooth' },
      { id: 'female-powerful', name: 'Powerful' },
      { id: 'female-high-pitched', name: 'High-Pitched' },
      { id: 'female-sultry', name: 'Sultry' },
    ],
  },
  {
    id: 'group-vocals',
    name: 'Group/Choir',
    description: 'Multiple voices',
    subOptions: [
      { id: 'duet', name: 'Duet' },
      { id: 'trio', name: 'Trio' },
      { id: 'choir', name: 'Choir' },
      { id: 'vocal-ensemble', name: 'Vocal Ensemble' },
      { id: 'layered-vocals', name: 'Layered Vocals' },
      { id: 'harmonized', name: 'Harmonized' },
    ],
  },
  {
    id: 'special-vocals',
    name: 'Special Vocals',
    description: 'Unique vocal styles',
    subOptions: [
      { id: 'rap', name: 'Rap' },
      { id: 'spoken-word', name: 'Spoken Word' },
      { id: 'whisper', name: 'Whisper' },
      { id: 'vocalization', name: 'Vocalization' },
      { id: 'robotic', name: 'Robotic' },
      { id: 'pitched-vocals', name: 'Pitched Vocals' },
    ],
  },
];
export const REFERENCES_BY_ERA = [
  {
    id: 'classic-70s-80s',
    name: 'Classic 70s-80s',
    description: 'Legendary artists from the 70s and 80s',
    subOptions: [
      { id: 'ref-beatles', name: 'The Beatles' },
      { id: 'ref-pink-floyd', name: 'Pink Floyd' },
      { id: 'ref-david-bowie', name: 'David Bowie' },
      { id: 'ref-queen', name: 'Queen' },
      { id: 'ref-led-zeppelin', name: 'Led Zeppelin' },
      { id: 'ref-depeche-mode', name: 'Depeche Mode' },
      { id: 'ref-joy-division', name: 'Joy Division' },
      { id: 'ref-kraftwerk', name: 'Kraftwerk' },
    ],
  },
  {
    id: '90s-alternative',
    name: '90s Alternative',
    description: '90s alternative and indie pioneers',
    subOptions: [
      { id: 'ref-radiohead', name: 'Radiohead' },
      { id: 'ref-nirvana', name: 'Nirvana' },
      { id: 'ref-sonic-youth', name: 'Sonic Youth' },
      { id: 'ref-cocteau-twins', name: 'Cocteau Twins' },
      { id: 'ref-my-bloody-valentine', name: 'My Bloody Valentine' },
      { id: 'ref-pixies', name: 'Pixies' },
      { id: 'ref-pavement', name: 'Pavement' },
      { id: 'ref-slowdive', name: 'Slowdive' },
    ],
  },
  {
    id: 'electronic-pioneers',
    name: 'Electronic Pioneers',
    description: 'Electronic and synth pioneers',
    subOptions: [
      { id: 'ref-daft-punk', name: 'Daft Punk' },
      { id: 'ref-aphex-twin', name: 'Aphex Twin' },
      { id: 'ref-autechre', name: 'Autechre' },
      { id: 'ref-boards-of-canada', name: 'Boards of Canada' },
      { id: 'ref-warp-records', name: 'Warp Records Artists' },
      { id: 'ref-squarepusher', name: 'Squarepusher' },
      { id: 'ref-amon-tobin', name: 'Amon Tobin' },
    ],
  },
  {
    id: 'modern-producers',
    name: 'Modern Producers (2000s-2010s)',
    description: 'Contemporary production legends',
    subOptions: [
      { id: 'ref-rick-rubin', name: 'Rick Rubin' },
      { id: 'ref-neptunes', name: 'Neptunes' },
      { id: 'ref-timbaland', name: 'Timbaland' },
      { id: 'ref-kanye-west', name: 'Kanye West' },
      { id: 'ref-pharrell', name: 'Pharrell Williams' },
      { id: 'ref-max-martin', name: 'Max Martin' },
      { id: 'ref-skrillex', name: 'Skrillex' },
    ],
  },
  {
    id: 'contemporary-artists',
    name: 'Contemporary Artists',
    description: 'Current and recent artists',
    subOptions: [
      { id: 'ref-tame-impala', name: 'Tame Impala' },
      { id: 'ref-grimes', name: 'Grimes' },
      { id: 'ref-the-weeknd', name: 'The Weeknd' },
      { id: 'ref-billie-eilish', name: 'Billie Eilish' },
      { id: 'ref-tyler-creator', name: 'Tyler, The Creator' },
      { id: 'ref-frank-ocean', name: 'Frank Ocean' },
      { id: 'ref-james-blake', name: 'James Blake' },
      { id: 'ref-arca', name: 'Arca' },
    ],
  },
  {
    id: 'techno-house',
    name: 'Techno & House Legends',
    description: 'Electronic dance music pioneers',
    subOptions: [
      { id: 'ref-richie-hawtin', name: 'Richie Hawtin' },
      { id: 'ref-carl-cox', name: 'Carl Cox' },
      { id: 'ref-jeff-mills', name: 'Jeff Mills' },
      { id: 'ref-derrick-may', name: 'Derrick May' },
      { id: 'ref-juan-atkins', name: 'Juan Atkins' },
      { id: 'ref-sasha-john-digweed', name: 'Sasha & John Digweed' },
      { id: 'ref-amelie-lens', name: 'Amelie Lens' },
      { id: 'ref-charlotte-de-witte', name: 'Charlotte de Witte' },
    ],
  },
];
export const MOOD_OPTIONS = [
  'Energetic',
  'Uplifting',
  'Melancholic',
  'Mysterious',
  'Romantic',
  'Calm',
  'Playful',
  'Epic',
  'Dark',
  'Ethereal',
  'Aggressive',
  'Introspective',
  'Joyful',
  'Nostalgic',
  'Hypnotic',
];
export const TEMPO_OPTIONS = [
  'Slow (80-100 BPM)',
  'Moderate (100-120 BPM)',
  'Fast (120-140 BPM)',
  'Very fast (140-160 BPM)',
];
export const KEY_OPTIONS = [
  'C Major',
  'C# Major',
  'D Major',
  'D# Major',
  'E Major',
  'F Major',
  'F# Major',
  'G Major',
  'G# Major',
  'A Major',
  'A# Major',
  'B Major',
  'C Minor',
  'C# Minor',
  'D Minor',
  'D# Minor',
  'E Minor',
  'F Minor',
  'F# Minor',
  'G Minor',
  'G# Minor',
  'A Minor',
  'A# Minor',
  'B Minor',
];
export const MODES_OPTIONS = [
  'Ionian (Bright, Happy)',
  'Dorian (Jazzy, Folk)',
  'Phrygian (Spanish, Exotic)',
  'Lydian (Dreamy, Majestic)',
  'Mixolydian (Bluesy, Rock)',
  'Aeolian (Sad, Melancholic)',
  'Locrian (Diminished, Unstable)',
];
export const STRUCTURE_OPTIONS = [
  'Verse-Chorus-Verse',
  'Verse-Chorus-Bridge-Chorus',
  'Intro-Verse-Chorus-Outro',
  'Minimal (Repetitive)',
  'Progressive (Building)',
  'Ambient (No structure)',
];
export const INSTRUMENTS_OPTIONS = [
  'Acoustic Guitar',
  'Electric Guitar',
  'Classical Guitar',
  'Nylon Guitar',
  'Acoustic Piano',
  'Electric Piano',
  'Synthesizer (General)',
  'Moog Synthesizer',
  'Wavetable Synth',
  'Pad Synth',
  'Lead Synth',
  'Bass Synth',
  'String Section',
  'Violin',
  'Cello',
  'String Quartet',
  'Brass Section',
  'Trumpet',
  'French Horn',
  'Saxophone',
  'Clarinet',
  'Oboe',
  'Flute',
  'Harp',
  'Ukulele',
  'Mandolin',
  'Banjo',
  'Harmonica',
  'Theremin',
  'Vibraphone',
  'Marimba',
  'Timpani',
  'Gong',
  'Woodwinds',
  'Horns',
  'Drums (Acoustic)',
  'Drums (Electronic)',
  'Bass Guitar',
  'Upright Bass',
  'Synth Bass',
];
export const PRODUCTION_OPTIONS = [
  'Clean',
  'Professional',
  'Vintage',
  'Lo-Fi',
  'Experimental',
  'Crisp',
  'Warm',
  'Bright',
  'Live Recording',
];
export const ERA_OPTIONS = [
  '1930s',
  '1940s',
  '1950s',
  '1960s',
  '1970s',
  '1980s',
  '1990s',
  '2000s',
  '2010s',
  '2020s',
  'Contemporary',
];
export const GOAL_OPTIONS = [
  'Background Music',
  'Dance Floor Banger',
  'Meditation',
  'Workout',
  'Focus/Study',
  'Sleep',
  'Party',
  'Cinematic',
  'Gaming',
  'Podcast',
  'TikTok',
  'Emotional',
  'Storytelling',
];
export const RHYTHM_OPTIONS = [
  'Straight (4/4)',
  'Triplet',
  'Swing',
  'Syncopated',
  'Polyrhythmic',
  'Minimal',
  'Broken',
  'Locked',
  'Groove-based',
];
export const GROOVE_FEEL_OPTIONS = [
  'Funky',
  'Smooth',
  'Driving',
  'Tight',
  'Loose',
  'Bouncy',
  'Laid-back',
  'Groovy',
  'Hypnotic',
];
export const BASS_TONE_OPTIONS = [
  'Deep Sub-Bass',
  'Warm Bass',
  'Punchy Bass',
  'Clean Bass',
  'Fuzzy Bass',
  'Melodic Bass',
  'Minimal Bass',
  'Prominent Bass',
  'Subtle Bass',
  'Filtered Bass',
  'Synth Bass',
  'Acoustic Bass',
  'Fretless Bass',
];
export const HARMONY_FORM_OPTIONS = [
  'Simple (I-IV-V)',
  'Jazz Harmony',
  'Modal Interchange',
  'Chromatic',
  'Diatonic',
  'Suspended Chords',
  'Diminished',
  'Augmented',
  'Parallel Motion',
  'Counterpoint',
  'Minimalist',
  'Borrowed Chords',
  'Circle of Fifths',
  'Key Change',
  'Extended Chords',
  'Descending Bass',
];
export const MELODY_OPTIONS = [
  'Melodic Vocal Line',
  'Wide Vocal Range',
  'Expressive Melody',
  'Soaring Chorus',
  'Vocal Runs',
  'Dynamic Vocal Performance',
  'Stepwise Melody',
  'Leaps And Arpeggios',
];
export const EAR_CANDY_SPACE_OPTIONS = [
  'Reverb-heavy',
  'Delay Effects',
  'Stereo Width',
  'Panning',
  'Spatial Effects',
  'Echo',
  'Chorus',
  'Flanger',
  'Phaser',
  'Distortion',
  'Compression',
  'Modulation',
];
export const MIX_MASTER_HIERARCHY = [
  {
    id: 'dynamics',
    name: 'Dynamics',
    description: 'Control dynamic range and punch',
    subOptions: [
      { id: 'compressed', name: 'Compressed' },
      { id: 'dynamic-range', name: 'Dynamic Range' },
      { id: 'loud-punchy', name: 'Loud and Punchy' },
      { id: 'balanced-mix', name: 'Balanced Mix' },
    ],
  },
  {
    id: 'vocal-presence',
    name: 'Vocal Presence',
    description: 'Control vocal prominence in mix',
    subOptions: [
      { id: 'vocal-forward', name: 'Vocal-Forward' },
      { id: 'vocal-balanced', name: 'Vocal-Balanced' },
      { id: 'instrumental-focused', name: 'Instrumental-Focused' },
    ],
  },
  {
    id: 'mastering',
    name: 'Mastering',
    description: 'Mastering tone and character',
    subOptions: [
      { id: 'warm-mastering', name: 'Warm Mastering' },
      { id: 'bright-mastering', name: 'Bright Mastering' },
      { id: 'dark-mastering', name: 'Dark Mastering' },
    ],
  },
  {
    id: 'stereo',
    name: 'Stereo/Spatial',
    description: 'Stereo width and spatial characteristics',
    subOptions: [
      { id: 'mono-compatible', name: 'Mono-Compatible' },
      { id: 'stereo-enhanced', name: 'Stereo-Enhanced' },
      { id: 'headphone-optimized', name: 'Headphone-Optimized' },
      { id: 'club-ready', name: 'Club-Ready' },
    ],
  },
];
export const PROMPT_CATEGORIES = [
  {
    id: 'mood',
    name: 'Mood',
    options: MOOD_OPTIONS,
    multiSelect: true,
  },
  {
    id: 'tempo',
    name: 'Tempo (BPM)',
    options: TEMPO_OPTIONS,
    multiSelect: true,
  },
  {
    id: 'key',
    name: 'Key',
    options: KEY_OPTIONS,
    multiSelect: true,
  },
  {
    id: 'modes',
    name: 'Modes',
    options: MODES_OPTIONS,
    multiSelect: true,
  },
  {
    id: 'instruments',
    name: 'Instruments',
    options: INSTRUMENTS_OPTIONS,
    multiSelect: true,
  },
  {
    id: 'production',
    name: 'Production Quality',
    options: PRODUCTION_OPTIONS,
    multiSelect: true,
  },
  {
    id: 'era',
    name: 'Musical Era',
    options: ERA_OPTIONS,
    multiSelect: true,
  },
  {
    id: 'goal',
    name: 'Goal',
    options: GOAL_OPTIONS,
    multiSelect: true,
  },
  {
    id: 'rhythm_groove',
    name: 'Rhythm',
    options: RHYTHM_OPTIONS,
    multiSelect: true,
  },
  {
    id: 'groove_feel',
    name: 'Groove Feel',
    options: GROOVE_FEEL_OPTIONS,
    multiSelect: true,
  },
  {
    id: 'bass_tone',
    name: 'Bass',
    options: BASS_TONE_OPTIONS,
    multiSelect: true,
  },
  {
    id: 'melody',
    name: 'Vocal melody',
    options: MELODY_OPTIONS,
    multiSelect: true,
  },
  {
    id: 'harmony_form',
    name: 'Harmony',
    options: HARMONY_FORM_OPTIONS,
    multiSelect: true,
  },
  {
    id: 'ear_candy_space',
    name: 'Ear-Candy',
    options: EAR_CANDY_SPACE_OPTIONS,
    multiSelect: true,
  },
  {
    id: 'mix_master',
    name: 'Mix & Master',
    options: MIX_MASTER_HIERARCHY,
    multiSelect: true,
    isHierarchical: true,
  },
  {
    id: 'vocal',
    name: 'Vocal',
    options: VOCAL_HIERARCHY,
    multiSelect: true,
    isHierarchical: true,
  },
];
export const SUNO_V6_PRESETS = {
  precision: {
    id: 'precision',
    name: 'Preset A: PRECISION',
    tagline: 'Strict adherence',
    description:
      'High fidelity to prompt tags. Locks style with minimum drift. Ideal for clearly defined genres, structural cohesion, and vocal consistency.',
    model: 'v6',
    styleInfluence: 90,
    variety: 0,
    weirdness: 10,
    maxMode: true,
  },
  balanced: {
    id: 'balanced',
    name: 'Preset B: BALANCED',
    tagline: 'Standard generation',
    description:
      'Guided musical direction with natural variation. Reliable starting point for standard production and cohesive tracks.',
    model: 'v6',
    styleInfluence: 65,
    variety: 25,
    weirdness: 35,
    maxMode: true,
  },
  exploration: {
    id: 'exploration',
    name: 'Preset C: EXPLORATION',
    tagline: 'Creative variations',
    description:
      'Style compliance with wider structural exploration. Discover unexpected genre blends and fresh arrangements.',
    model: 'v6',
    styleInfluence: 40,
    variety: 75,
    weirdness: 60,
    maxMode: false,
  },
  laboratory: {
    id: 'laboratory',
    name: 'Preset D: LABORATORY',
    tagline: 'Experimental ideation',
    description:
      'Unrestricted experimental exploration and eccentric musical choices powered by the v6-wild model.',
    model: 'v6-wild',
    styleInfluence: 20,
    variety: 100,
    weirdness: 90,
    maxMode: false,
  },
};
export function recommendSunoV6Params(state) {
  const genres = (state.genres || []).map(g => g.toLowerCase());
  const moods = (state.mood || []).map(m => m.toLowerCase());
  const goals = (state.goal || []).map(g => g.toLowerCase());
  const isExperimental =
    genres.some(g =>
      ['experimental', 'avant-garde', 'glitch', 'idm', 'noise', 'psychedelic', 'industrial'].some(k =>
        g.includes(k)
      )
    ) || moods.some(m => ['psychedelic', 'experimental', 'chaotic'].some(k => m.includes(k)));
  const isExploration =
    genres.some(g => ['fusion', 'crossover', 'alternative', 'indie', 'world'].some(k => g.includes(k))) ||
    goals.some(g => ['creative', 'unexpected'].some(k => g.includes(k)));
  const isStandardPopRock = genres.some(g =>
    ['pop', 'rock', 'metal', 'acoustic', 'ballad', 'folk', 'country', 'classical'].some(k => g.includes(k))
  );
  if (isExperimental) {
    return {
      model: 'v6-wild',
      styleInfluence: 25,
      variety: 100,
      weirdness: 85,
      maxMode: false,
      preset: 'laboratory',
    };
  }
  if (isExploration) {
    return {
      model: 'v6',
      styleInfluence: 45,
      variety: 75,
      weirdness: 55,
      maxMode: false,
      preset: 'exploration',
    };
  }
  if (isStandardPopRock) {
    return {
      model: 'v6',
      styleInfluence: 88,
      variety: 0,
      weirdness: 10,
      maxMode: true,
      preset: 'precision',
    };
  }
  return {
    model: 'v6',
    styleInfluence: 65,
    variety: 25,
    weirdness: 35,
    maxMode: true,
    preset: 'balanced',
  };
}
export function varietyToLabel(val) {
  const num = typeof val === 'string' ? parseFloat(val) : val;
  if (isNaN(num)) return String(val);
  if (num <= 5) return 'Off (0%)';
  if (num <= 35) return 'Normal (~25%)';
  if (num <= 65) return 'High (~50%)';
  if (num <= 85) return 'Extra (~75%)';
  return 'Max (100%)';
}
export function varietyStepName(val) {
  const num = typeof val === 'string' ? parseFloat(val) : val;
  if (isNaN(num)) return String(val);
  if (num <= 5) return 'Off';
  if (num <= 35) return 'Normal';
  if (num <= 65) return 'High';
  if (num <= 85) return 'Extra';
  return 'Max';
}
