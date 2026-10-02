// Fixed category lists. Claude and the local parser both map into these.
export const EXPENSE_CATEGORIES = [
  'Paket Bridal',
  'Venue',
  'Catering',
  'Decoration',
  'Attire & Makeup',
  'Photo & Video',
  'Entertainment',
  'Invitations & Souvenirs',
  'Rings & Jewelry',
  'Seserahan & Mahar',
  'Transport & Accommodation',
  'Honeymoon',
  'Admin & Ceremony',
  'Other',
];

export const INCOME_CATEGORIES = ['Angpao & Gifts', 'Family Contribution', 'Other Income'];

// Keyword hints for the offline parser (lowercase, Bahasa + English).
export const KEYWORDS = {
  // Checked first: a payment that mentions the package belongs to it, even if it also says "catering".
  'Paket Bridal': ['paket', 'bridal', 'package', 'all in', 'all-in'],
  Venue: ['venue', 'gedung', 'ballroom', 'hall', 'hotel venue', 'tempat', 'sewa gedung', 'resepsi'],
  Catering: ['catering', 'katering', 'makan', 'food', 'buffet', 'prasmanan', 'kue', 'cake', 'wedding cake', 'snack'],
  Decoration: ['dekor', 'decor', 'dekorasi', 'bunga', 'flower', 'florist', 'pelaminan', 'lighting'],
  'Attire & Makeup': ['makeup', 'make up', 'mua', 'gaun', 'dress', 'gown', 'jas', 'suit', 'kebaya', 'beskap', 'baju', 'rias', 'salon', 'hair'],
  'Photo & Video': ['foto', 'photo', 'video', 'prewed', 'prewedding', 'dokumentasi', 'fotografer', 'photographer', 'drone'],
  Entertainment: ['band', 'musik', 'music', 'dj', 'mc', 'singer', 'penyanyi', 'sound', 'entertainment', 'organ'],
  'Invitations & Souvenirs': ['undangan', 'invitation', 'souvenir', 'suvenir', 'cetak', 'print', 'hampers'],
  'Rings & Jewelry': ['cincin', 'ring', 'perhiasan', 'jewelry', 'emas', 'gold'],
  'Seserahan & Mahar': ['seserahan', 'mahar', 'hantaran', 'mas kawin', 'lamaran'],
  'Transport & Accommodation': ['mobil', 'car', 'transport', 'bensin', 'tiket', 'ticket', 'pesawat', 'flight', 'hotel', 'penginapan', 'villa'],
  Honeymoon: ['honeymoon', 'bulan madu'],
  'Admin & Ceremony': ['kua', 'catatan sipil', 'capil', 'gereja', 'church', 'pemberkatan', 'admin', 'pendeta', 'penghulu', 'wo', 'wedding organizer', 'organizer'],
};

export const INCOME_KEYWORDS = ['angpao', 'angpau', 'amplop', 'kado', 'hadiah', 'gift', 'sumbangan', 'terima', 'received', 'dapat', 'masuk', 'kontribusi', 'contribution', 'dikasih', 'dari ortu', 'dari mama', 'dari papa'];

// What the all-in package covers — shown on the dashboard and given to Claude as context.
export const PACKAGE_NOTE = 'Paket Bridal 69 jt (DP 50% = 34,5 jt): venue, make up standard, catering 250 pax, kue, dekorasi standard';
