/**
 * DEMO MA'LUMOT MANBAI.
 *
 * ⚠️ Ro'yxatlar KODDA, baza ichida emas: ular seed uchun va seed
 * `npm run seed` bilan QAYTA ishga tushishi mumkin. Agar ular bazada
 * tursa, «demo ma'lumotni qaytadan yozish» uchun avval uni qidirib
 * topish kerak bo'lardi.
 */

export const BOILER_BRANDS = [
  { name: 'Ferroli', country: 'Italiya' },
  { name: 'Buderus', country: 'Germaniya' },
  { name: 'Viessmann', country: 'Germaniya' },
  { name: 'Kiturami', country: 'Janubiy Koreya' },
  { name: 'Navien', country: 'Janubiy Koreya' },
  { name: 'Baxi', country: 'Italiya' },
  { name: 'ICI Caldaie', country: 'Italiya' },
  { name: 'Uzbekkotlomash', country: 'O‘zbekiston' },
];

export const FIRMS = [
  {
    name: 'DXSH «Andijon Issiqlik Servis»',
    tin: '301234567',
    directorName: 'Rustam Qosimov',
  },
  {
    name: 'DXSH «Vodiy Energo Montaj»',
    tin: '302345678',
    directorName: 'Shuhrat Yo‘ldoshev',
  },
  {
    name: 'DXSH «Issiqlik Taminot Qurilish»',
    tin: '303456789',
    directorName: 'Bekzod Ahmedov',
  },
  {
    name: 'DXSH «Termo Profi Servis»',
    tin: '304567890',
    directorName: 'Ulug‘bek Mamatov',
  },
  {
    name: 'DXSH «Andijon Gaz Ta‘mir»',
    tin: '305678901',
    directorName: 'Dilshod Normatov',
  },
  {
    name: 'DXSH «Qozon Montaj Invest»',
    tin: '306789012',
    directorName: 'Sardor Tursunov',
  },
];

/** Tashkilot nomi shablonlari — tuman nomi bilan to'ldiriladi. */
export const ORGANIZATION_TEMPLATES: Array<{
  pattern: string;
  kind: string;
}> = [
  { pattern: '{n}-son umumta‘lim maktabi', kind: 'school' },
  { pattern: '{n}-son bolalar bog‘chasi', kind: 'kindergarten' },
  { pattern: '{district} tuman markaziy shifoxonasi', kind: 'hospital' },
  { pattern: '{district} oilaviy poliklinikasi', kind: 'clinic' },
  { pattern: '{district} kasb-hunar kolleji', kind: 'college' },
  { pattern: '{district} hokimligi binosi', kind: 'admin' },
  { pattern: '{n}-son turar-joy majmuasi', kind: 'residential' },
];

export const RESPONSIBLE_NAMES = [
  'Akmal Tursunov',
  'Dilshod Rahimov',
  'Sherzod Qodirov',
  'Nodir Ismoilov',
  'Jasur Abdullayev',
  'Otabek Nazarov',
  'Sanjar Yusupov',
  'Bobur Xolmatov',
  'Aziz Mahmudov',
  'Farrux Sodiqov',
];
