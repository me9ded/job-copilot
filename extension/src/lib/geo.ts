import { normalizeForCompare } from './util';

/**
 * Small, offline place tables used to split "Ottawa, ON" into its parts and to
 * match country / province pickers on application forms. Nothing is looked up
 * online.
 */

export interface Region {
  code: string;
  name: string;
  country: 'CA' | 'US';
  aliases: string[];
}

export interface Country {
  code: string;
  name: string;
  dial: string;
  aliases: string[];
}

const CA_REGIONS =
  'AB:Alberta|BC:British Columbia:Colombie-Britannique|MB:Manitoba|NB:New Brunswick:Nouveau-Brunswick|NL:Newfoundland and Labrador:Newfoundland;Terre-Neuve-et-Labrador|NS:Nova Scotia:Nouvelle-Écosse|NT:Northwest Territories:NWT|NU:Nunavut|ON:Ontario|PE:Prince Edward Island:PEI;Île-du-Prince-Édouard|QC:Quebec:Québec;PQ|SK:Saskatchewan|YT:Yukon:Yukon Territory';
const US_REGIONS =
  'AL:Alabama|AK:Alaska|AZ:Arizona|AR:Arkansas|CA:California|CO:Colorado|CT:Connecticut|DE:Delaware|DC:District of Columbia:Washington DC;Washington D.C.|FL:Florida|GA:Georgia|HI:Hawaii|ID:Idaho|IL:Illinois|IN:Indiana|IA:Iowa|KS:Kansas|KY:Kentucky|LA:Louisiana|ME:Maine|MD:Maryland|MA:Massachusetts|MI:Michigan|MN:Minnesota|MS:Mississippi|MO:Missouri|MT:Montana|NE:Nebraska|NV:Nevada|NH:New Hampshire|NJ:New Jersey|NM:New Mexico|NY:New York|NC:North Carolina|ND:North Dakota|OH:Ohio|OK:Oklahoma|OR:Oregon|PA:Pennsylvania|RI:Rhode Island|SC:South Carolina|SD:South Dakota|TN:Tennessee|TX:Texas|UT:Utah|VT:Vermont|VA:Virginia|WA:Washington|WV:West Virginia|WI:Wisconsin|WY:Wyoming|PR:Puerto Rico';

const COUNTRY_DATA = `AF|Afghanistan|93
AL|Albania|355
DZ|Algeria|213|Algérie
AD|Andorra|376
AO|Angola|244
AG|Antigua and Barbuda|1
AR|Argentina|54
AM|Armenia|374
AU|Australia|61
AT|Austria|43
AZ|Azerbaijan|994
BS|Bahamas|1|The Bahamas
BH|Bahrain|973
BD|Bangladesh|880
BB|Barbados|1
BY|Belarus|375
BE|Belgium|32|Belgique
BZ|Belize|501
BJ|Benin|229
BT|Bhutan|975
BO|Bolivia|591|Bolivia, Plurinational State of
BA|Bosnia and Herzegovina|387|Bosnia
BW|Botswana|267
BR|Brazil|55|Brasil
BN|Brunei|673|Brunei Darussalam
BG|Bulgaria|359
BF|Burkina Faso|226
BI|Burundi|257
CV|Cabo Verde|238|Cape Verde
KH|Cambodia|855
CM|Cameroon|237|Cameroun
CA|Canada|1
CF|Central African Republic|236
TD|Chad|235
CL|Chile|56
CN|China|86|People's Republic of China;PRC;Mainland China
CO|Colombia|57
KM|Comoros|269
CG|Congo|242|Republic of the Congo;Congo-Brazzaville
CD|Democratic Republic of the Congo|243|DR Congo;DRC;Congo, The Democratic Republic of the;Congo-Kinshasa
CR|Costa Rica|506
CI|Côte d'Ivoire|225|Ivory Coast;Cote d'Ivoire
HR|Croatia|385
CU|Cuba|53
CY|Cyprus|357
CZ|Czechia|420|Czech Republic
DK|Denmark|45
DJ|Djibouti|253
DM|Dominica|1
DO|Dominican Republic|1
EC|Ecuador|593
EG|Egypt|20
SV|El Salvador|503
GQ|Equatorial Guinea|240
ER|Eritrea|291
EE|Estonia|372
SZ|Eswatini|268|Swaziland
ET|Ethiopia|251
FJ|Fiji|679
FI|Finland|358
FR|France|33
GA|Gabon|241
GM|Gambia|220|The Gambia
GE|Georgia|995
DE|Germany|49|Deutschland
GH|Ghana|233
GR|Greece|30
GD|Grenada|1
GT|Guatemala|502
GN|Guinea|224
GW|Guinea-Bissau|245
GY|Guyana|592
HT|Haiti|509
HN|Honduras|504
HK|Hong Kong|852|Hong Kong SAR
HU|Hungary|36
IS|Iceland|354
IN|India|91
ID|Indonesia|62
IR|Iran|98|Iran, Islamic Republic of
IQ|Iraq|964
IE|Ireland|353|Republic of Ireland
IL|Israel|972
IT|Italy|39|Italia
JM|Jamaica|1
JP|Japan|81
JO|Jordan|962
KZ|Kazakhstan|7
KE|Kenya|254
KI|Kiribati|686
KP|North Korea|850|Korea, Democratic People's Republic of
KR|South Korea|82|Korea, Republic of;Republic of Korea;Korea
XK|Kosovo|383
KW|Kuwait|965
KG|Kyrgyzstan|996
LA|Laos|856|Lao People's Democratic Republic
LV|Latvia|371
LB|Lebanon|961|Liban
LS|Lesotho|266
LR|Liberia|231
LY|Libya|218
LI|Liechtenstein|423
LT|Lithuania|370
LU|Luxembourg|352
MO|Macao|853|Macau
MG|Madagascar|261
MW|Malawi|265
MY|Malaysia|60
MV|Maldives|960
ML|Mali|223
MT|Malta|356
MH|Marshall Islands|692
MR|Mauritania|222
MU|Mauritius|230
MX|Mexico|52|México
FM|Micronesia|691
MD|Moldova|373|Moldova, Republic of
MC|Monaco|377
MN|Mongolia|976
ME|Montenegro|382
MA|Morocco|212|Maroc
MZ|Mozambique|258
MM|Myanmar|95|Burma
NA|Namibia|264
NR|Nauru|674
NP|Nepal|977
NL|Netherlands|31|The Netherlands;Holland
NZ|New Zealand|64
NI|Nicaragua|505
NE|Niger|227
NG|Nigeria|234
MK|North Macedonia|389|Macedonia
NO|Norway|47
OM|Oman|968
PK|Pakistan|92
PW|Palau|680
PS|Palestine|970|Palestine, State of
PA|Panama|507
PG|Papua New Guinea|675
PY|Paraguay|595
PE|Peru|51
PH|Philippines|63
PL|Poland|48
PT|Portugal|351
PR|Puerto Rico|1
QA|Qatar|974
RO|Romania|40
RU|Russia|7|Russian Federation
RW|Rwanda|250
KN|Saint Kitts and Nevis|1
LC|Saint Lucia|1
VC|Saint Vincent and the Grenadines|1
WS|Samoa|685
SM|San Marino|378
ST|Sao Tome and Principe|239
SA|Saudi Arabia|966
SN|Senegal|221|Sénégal
RS|Serbia|381
SC|Seychelles|248
SL|Sierra Leone|232
SG|Singapore|65
SK|Slovakia|421
SI|Slovenia|386
SB|Solomon Islands|677
SO|Somalia|252
ZA|South Africa|27
SS|South Sudan|211
ES|Spain|34|España
LK|Sri Lanka|94
SD|Sudan|249
SR|Suriname|597
SE|Sweden|46
CH|Switzerland|41|Suisse;Schweiz
SY|Syria|963|Syrian Arab Republic
TW|Taiwan|886
TJ|Tajikistan|992
TZ|Tanzania|255|Tanzania, United Republic of
TH|Thailand|66
TL|Timor-Leste|670|East Timor
TG|Togo|228
TO|Tonga|676
TT|Trinidad and Tobago|1
TN|Tunisia|216|Tunisie
TR|Türkiye|90|Turkey;Turkiye
TM|Turkmenistan|993
TV|Tuvalu|688
UG|Uganda|256
UA|Ukraine|380
AE|United Arab Emirates|971|UAE;U.A.E.
GB|United Kingdom|44|UK;U.K.;Great Britain;Britain;England;Scotland;Wales;Northern Ireland;United Kingdom of Great Britain and Northern Ireland
US|United States|1|USA;U.S.;U.S.A.;United States of America;America
UY|Uruguay|598
UZ|Uzbekistan|998
VU|Vanuatu|678
VA|Vatican City|39|Holy See
VE|Venezuela|58|Venezuela, Bolivarian Republic of
VN|Vietnam|84|Viet Nam
YE|Yemen|967
ZM|Zambia|260
ZW|Zimbabwe|263`;

function regions(data: string, country: Region['country']): Region[] {
  return data.split('|').map((r) => {
    const [code, name, aliases = ''] = r.split(':');
    return { code: code!, name: name!, country, aliases: aliases.split(';').filter(Boolean) };
  });
}

export const REGIONS: Region[] = [...regions(CA_REGIONS, 'CA'), ...regions(US_REGIONS, 'US')];

export const COUNTRIES: Country[] = COUNTRY_DATA.split('\n').map((line) => {
  const [code, name, dial, aliases = ''] = line.split('|');
  return { code: code!, name: name!, dial: dial!, aliases: aliases.split(';').filter(Boolean) };
});

const key = (s: string) => normalizeForCompare(s.replace(/\./g, ''));

const COUNTRY_INDEX = new Map<string, Country>();
for (const c of COUNTRIES) for (const n of [c.name, ...c.aliases]) COUNTRY_INDEX.set(key(n), c);
const COUNTRY_CODES = new Map(COUNTRIES.map((c) => [c.code, c]));

const REGION_NAMES = new Map<string, Region>();
for (const r of REGIONS) for (const n of [r.name, ...r.aliases]) REGION_NAMES.set(key(n), r);

/** A country by name, alias ("USA", "Turkey") or, when `codes` is set, ISO code ("CA"). */
export function findCountry(text: string, codes = true): Country | undefined {
  const t = text.trim();
  if (!t) return undefined;
  if (codes && /^[A-Z]{2}$/.test(t)) return COUNTRY_CODES.get(t);
  if (codes && /^[A-Z]{3}$/.test(t)) return t === 'USA' ? COUNTRY_CODES.get('US') : t === 'GBR' ? COUNTRY_CODES.get('GB') : t === 'CAN' ? COUNTRY_CODES.get('CA') : undefined;
  return COUNTRY_INDEX.get(key(t));
}

export function countryByCode(code: string): Country | undefined {
  return COUNTRY_CODES.get(code.toUpperCase());
}

/** A Canadian province / territory or US state by code ("ON") or name ("Ontario", "Québec"). */
export function findRegion(text: string, country?: Region['country']): Region | undefined {
  const t = text.trim();
  if (!t) return undefined;
  const pool = country ? REGIONS.filter((r) => r.country === country) : REGIONS;
  if (/^[A-Za-z]{2}$/.test(t)) {
    const code = t.toUpperCase();
    // Two-letter codes are written in capitals; "in" or "or" in running text are words.
    if (t !== code) return undefined;
    // "CA" is California in "Los Angeles, CA"; Canada is matched by name.
    return pool.find((r) => r.code === code && r.country === 'US') ?? pool.find((r) => r.code === code);
  }
  const hit = REGION_NAMES.get(key(t));
  return hit && (!country || hit.country === country) ? hit : undefined;
}

export interface PlaceParts {
  city: string;
  region: string;
  regionCode: string;
  country: string;
  countryCode: string;
  postalCode: string;
  remote: boolean;
  /** The country was not written but follows from the province / state. */
  countryInferred: boolean;
}

const POSTAL_RE = /\b([ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z])\s?(\d[ABCEGHJ-NPRSTV-Z]\d)\b|\b(\d{5})(?:-\d{4})?\b/i;

/**
 * Splits a free-form location ("Ottawa, ON", "Toronto, Ontario, Canada",
 * "Tunis, Tunisia", "Remote (Canada)") into parts. Unknown parts are left
 * empty; nothing is guessed beyond the country of a known province or state.
 */
export function parseLocation(raw: string): PlaceParts {
  const out: PlaceParts = { city: '', region: '', regionCode: '', country: '', countryCode: '', postalCode: '', remote: false, countryInferred: false };
  let text = raw.replace(/^\s*(location|based in|address)\s*:\s*/i, '').trim();
  if (!text) return out;
  if (/\bremote\b/i.test(text)) {
    out.remote = true;
    text = text.replace(/\(?\bremote\b\)?\s*[-–—,/|]?\s*/i, '').replace(/[()]/g, '').trim();
  }
  const postal = text.match(POSTAL_RE);
  if (postal) {
    out.postalCode = postal[3] ?? `${postal[1]!.toUpperCase()} ${postal[2]!.toUpperCase()}`;
    text = text.replace(postal[0], '').trim();
  }
  const parts = text
    .split(/\s*[,/|·•]\s*|\s+[-–—]\s+/)
    .map((p) => p.replace(/[()]/g, '').trim())
    .filter(Boolean);
  const setCountry = (c: Country) => {
    out.country = c.name;
    out.countryCode = c.code;
  };
  // Last part: a country? After a city, provinces / states win ("Atlanta, Georgia", "Chennai, IN" is rare).
  const last = parts[parts.length - 1];
  if (last && !(parts.length > 1 && findRegion(last))) {
    const c = findCountry(last, parts.length === 1 || !/^[A-Z]{2}$/.test(last));
    if (c) {
      setCountry(c);
      parts.pop();
    }
  }
  const maybeRegion = parts[parts.length - 1];
  if (maybeRegion && (parts.length > 1 || !out.country)) {
    const r = findRegion(maybeRegion, out.countryCode === 'CA' || out.countryCode === 'US' ? (out.countryCode as Region['country']) : undefined);
    // A lone "Georgia", "Washington" or "New York" is ambiguous (country or city); other names and codes are regions.
    if (r && (parts.length > 1 || out.country || /^[A-Z]{2}$/.test(maybeRegion) || !/^(georgia|washington|new york)$/i.test(maybeRegion))) {
      out.region = r.name;
      out.regionCode = r.code;
      parts.pop();
      if (!out.country) {
        setCountry(COUNTRY_CODES.get(r.country)!);
        out.countryInferred = true;
      }
    }
  }
  if (parts.length) out.city = parts[0]!;
  return out;
}

/** Ways a province / state may be written in a form ("Ontario", "ON"). */
export function regionVariants(region: string): string[] {
  const r = findRegion(region);
  return r ? [r.name, r.code, ...r.aliases] : region ? [region] : [];
}

/** Ways a country may be written in a form ("Canada", "CA", "United States of America"). */
export function countryVariants(country: string): string[] {
  const c = findCountry(country);
  if (!c) return country ? [country] : [];
  const iso3: Record<string, string> = { US: 'USA', GB: 'GBR', CA: 'CAN' };
  return [c.name, ...c.aliases, c.code, ...(iso3[c.code] ? [iso3[c.code]!] : [])];
}
