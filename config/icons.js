'use strict';

// Curated Lucide icons for the full picker (~150 icons covering daily use).
// Names must match Lucide's kebab-case identifiers. Order = approximate
// frequency-of-use, so fallback suggestions (when no keyword matches) and
// the first rows of the picker feel "everyday" rather than alphabetical.

const CURATED_FULL = [
  // default / generic
  'circle-dashed', 'check', 'star', 'heart', 'flag', 'bookmark', 'bell',

  // shopping / household
  'shopping-bag', 'shopping-cart', 'home', 'bed', 'bath', 'sofa', 'lamp',
  'light-bulb', 'washing-machine', 'shirt', 'sparkles',

  // work / communication
  'briefcase', 'laptop', 'monitor', 'keyboard', 'mouse', 'printer',
  'phone', 'phone-call', 'message-circle', 'mail', 'send',
  'video', 'mic', 'users', 'user', 'user-plus',

  // time / calendar
  'calendar', 'calendar-check', 'calendar-clock', 'clock', 'alarm-clock',
  'hourglass', 'timer',

  // learning / reading
  'book', 'book-open', 'pencil', 'pen', 'highlighter', 'graduation-cap',
  'file-text', 'clipboard', 'notebook', 'language',

  // health
  'pill', 'stethoscope', 'syringe', 'thermometer', 'heart-pulse', 'bandage',
  'hospital', 'brain', 'ear', 'eye', 'tooth', 'droplet',

  // fitness / outdoors
  'dumbbell', 'bike', 'footprints', 'activity', 'mountain', 'tent',
  'backpack', 'compass', 'map', 'map-pin',

  // food
  'coffee', 'cup-soda', 'wine', 'beer', 'utensils', 'utensils-crossed',
  'sandwich', 'pizza', 'salad', 'soup', 'cake-slice', 'ice-cream',
  'apple', 'banana', 'carrot', 'cherry', 'croissant', 'cookie',
  'egg', 'fish', 'ham', 'drumstick',

  // travel
  'car', 'car-front', 'bus', 'plane', 'train-front', 'ship',
  'truck', 'fuel', 'luggage', 'ticket',

  // finance
  'wallet', 'credit-card', 'banknote', 'coins', 'piggy-bank', 'receipt',
  'trending-up', 'trending-down',

  // entertainment
  'music', 'music-2', 'headphones', 'film', 'tv', 'gamepad-2', 'dices',
  'camera', 'image',

  // nature / weather
  'sun', 'moon', 'cloud', 'cloud-rain', 'cloud-snow', 'snowflake',
  'leaf', 'flower', 'trees', 'sprout',

  // tools
  'hammer', 'wrench', 'screwdriver', 'scissors', 'paintbrush', 'brush',
  'plug', 'battery', 'key', 'lock', 'unlock',

  // misc
  'gift', 'party-popper', 'umbrella', 'puzzle', 'target', 'rocket',
  'dog', 'cat', 'baby', 'paw-print', 'smile',
];

// Keyword → Lucide icon name. Hand-curated RU + EN pairs, matched per-word
// against the task text. Supports prefix match (word startsWith keyword or
// vice versa) for simple stem tolerance. Expand organically.

const ICON_KEYWORDS = {
  // shopping
  'магазин': 'shopping-bag', 'покупк': 'shopping-bag', 'купить': 'shopping-bag',
  'shop': 'shopping-bag', 'buy': 'shopping-bag', 'groceries': 'shopping-cart',
  'продукт': 'shopping-cart',

  // home
  'дом': 'home', 'home': 'home',
  'уборк': 'sparkles', 'убрать': 'sparkles', 'clean': 'sparkles',
  'стирк': 'washing-machine', 'постирать': 'washing-machine', 'laundry': 'washing-machine',
  'гладить': 'shirt',
  'посуд': 'utensils-crossed', 'вынести': 'trash-2', 'мусор': 'trash-2',

  // work
  'работ': 'briefcase', 'work': 'briefcase', 'job': 'briefcase',
  'встреч': 'users', 'meeting': 'users',
  'созвон': 'video', 'call': 'phone-call', 'звонок': 'phone', 'позвонить': 'phone',
  'письмо': 'mail', 'email': 'mail', 'почт': 'mail', 'написать': 'mail',
  'отчёт': 'file-text', 'отчет': 'file-text', 'report': 'file-text',

  // fitness
  'зал': 'dumbbell', 'спорт': 'dumbbell', 'gym': 'dumbbell', 'тренировк': 'dumbbell',
  'бег': 'footprints', 'run': 'footprints', 'пробежк': 'footprints',
  'велосипед': 'bike', 'велик': 'bike', 'bike': 'bike',
  'йога': 'flower',
  'ходьба': 'footprints', 'шаги': 'footprints',

  // health
  'таблетк': 'pill', 'лекарств': 'pill', 'pill': 'pill', 'pills': 'pill',
  'витамин': 'pill', 'vitamin': 'pill',
  'врач': 'stethoscope', 'доктор': 'stethoscope', 'doctor': 'stethoscope',
  'стоматолог': 'tooth', 'зуб': 'tooth',
  'капли': 'droplet',

  // food
  'кофе': 'coffee', 'coffee': 'coffee', 'капучино': 'coffee',
  'чай': 'cup-soda', 'tea': 'cup-soda',
  'завтрак': 'sandwich', 'breakfast': 'sandwich',
  'обед': 'utensils', 'lunch': 'utensils',
  'ужин': 'utensils', 'dinner': 'utensils',
  'еда': 'utensils', 'food': 'utensils', 'перекус': 'cookie',
  'молоко': 'milk', 'milk': 'milk',
  'вода': 'droplet', 'water': 'droplet', 'попить': 'cup-soda',
  'вино': 'wine', 'пиво': 'beer',

  // travel
  'машин': 'car', 'car': 'car', 'авто': 'car',
  'заправк': 'fuel', 'бензин': 'fuel', 'gas': 'fuel',
  'такси': 'car-front', 'taxi': 'car-front',
  'самолёт': 'plane', 'самолет': 'plane', 'plane': 'plane', 'flight': 'plane',
  'поезд': 'train-front', 'train': 'train-front',

  // finance
  'деньги': 'wallet', 'money': 'wallet',
  'оплат': 'credit-card', 'заплатить': 'credit-card', 'pay': 'credit-card',
  'счёт': 'receipt', 'счет': 'receipt', 'bill': 'receipt',
  'накопить': 'piggy-bank',

  // learning / reading
  'книг': 'book-open', 'book': 'book-open', 'читать': 'book-open', 'прочитать': 'book-open',
  'учёб': 'graduation-cap', 'учеб': 'graduation-cap', 'курс': 'graduation-cap', 'study': 'graduation-cap',
  'записать': 'pencil', 'заметк': 'pencil',

  // family / people
  'лид': 'heart', 'лёв': 'baby', 'мир': 'baby',
  'мама': 'heart', 'папа': 'heart', 'семь': 'heart',
  'ребёнок': 'baby', 'ребенок': 'baby', 'дети': 'baby', 'baby': 'baby',
  'собак': 'dog', 'пёс': 'dog', 'dog': 'dog',
  'кот': 'cat', 'кошк': 'cat', 'cat': 'cat',

  // time
  'будильник': 'alarm-clock', 'встать': 'alarm-clock', 'проснуться': 'alarm-clock',
  'таймер': 'timer',

  // entertainment
  'музык': 'music', 'music': 'music', 'плейлист': 'music',
  'кино': 'film', 'фильм': 'film', 'movie': 'film',
  'игр': 'gamepad-2', 'game': 'gamepad-2',
  'фото': 'camera', 'снять': 'camera', 'photo': 'camera',

  // misc
  'подарок': 'gift', 'gift': 'gift', 'праздник': 'party-popper',
  'ключ': 'key', 'key': 'key',
  'зонт': 'umbrella',
  'ракет': 'rocket', 'проект': 'rocket',
  'цель': 'target', 'goal': 'target',
};
