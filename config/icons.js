'use strict';

// Curated Lucide icons for the full picker (~220 icons covering daily use).
// Names must match Lucide's kebab-case identifiers. Order = approximate
// frequency-of-use, so fallback suggestions (when no keyword matches) and
// the first rows of the picker feel "everyday" rather than alphabetical.

const CURATED_FULL = [
  // default / generic
  'circle-dashed', 'check', 'star', 'heart', 'flag', 'bookmark', 'bell',
  'sparkles', 'sparkle', 'zap', 'flame',

  // shopping / household
  'shopping-bag', 'shopping-cart', 'shopping-basket', 'store', 'package',
  'home', 'bed', 'bed-double', 'bath', 'shower-head', 'sofa', 'armchair',
  'lamp', 'lightbulb', 'washing-machine', 'shirt', 'broom', 'trash-2',
  'door-open', 'door-closed', 'warehouse', 'fence',

  // work / communication
  'briefcase', 'laptop', 'monitor', 'keyboard', 'mouse', 'printer',
  'phone', 'phone-call', 'phone-outgoing', 'phone-incoming',
  'message-circle', 'message-square', 'mail', 'mail-open', 'send', 'inbox',
  'video', 'mic', 'headphones', 'users', 'user', 'user-plus', 'user-check',
  'presentation', 'bot', 'building', 'building-2', 'landmark',

  // time / calendar
  'calendar', 'calendar-check', 'calendar-clock', 'calendar-days',
  'calendar-plus', 'calendar-x', 'clock', 'alarm-clock', 'alarm-clock-check',
  'hourglass', 'timer', 'watch', 'history', 'repeat',

  // learning / reading
  'book', 'book-open', 'book-marked', 'pencil', 'pen', 'highlighter',
  'graduation-cap', 'file-text', 'clipboard', 'clipboard-check', 'clipboard-list',
  'notebook', 'notebook-pen', 'language', 'library', 'school', 'university',
  'scroll', 'sticky-note', 'bookmark', 'lightbulb',

  // health
  'pill', 'tablets', 'stethoscope', 'syringe', 'thermometer', 'heart-pulse',
  'bandage', 'hospital', 'brain', 'ear', 'eye', 'eye-off', 'tooth', 'droplet',
  'droplets', 'flask-conical', 'microscope', 'ambulance', 'cross', 'glasses',

  // fitness / outdoors
  'dumbbell', 'bike', 'footprints', 'activity', 'mountain', 'mountain-snow',
  'tent', 'tent-tree', 'backpack', 'compass', 'map', 'map-pin', 'map-pinned',
  'trees', 'tree-deciduous', 'tree-pine', 'waves', 'sailboat', 'anchor',
  'trophy', 'medal', 'target', 'goal', 'volleyball', 'helmet',

  // food
  'coffee', 'cup-soda', 'wine', 'beer', 'martini', 'utensils', 'utensils-crossed',
  'fork-knife', 'chef-hat', 'sandwich', 'pizza', 'salad', 'soup', 'cake',
  'cake-slice', 'ice-cream', 'ice-cream-cone', 'cookie', 'donut', 'candy',
  'popcorn', 'popsicle', 'lollipop', 'dessert', 'apple', 'banana', 'carrot',
  'cherry', 'citrus', 'croissant', 'egg', 'egg-fried', 'fish', 'ham',
  'drumstick', 'beef', 'milk', 'wheat', 'nut', 'tomato', 'leafy-green', 'lemon',

  // travel
  'car', 'car-front', 'bus', 'plane', 'plane-takeoff', 'plane-landing',
  'train-front', 'train-track', 'tram-front', 'ship', 'sailboat', 'rocket',
  'truck', 'fuel', 'luggage', 'ticket', 'baggage-claim', 'navigation',
  'route', 'road', 'taxi',

  // finance
  'wallet', 'credit-card', 'banknote', 'coins', 'piggy-bank', 'receipt',
  'trending-up', 'trending-down', 'calculator', 'dollar-sign',
  'russian-ruble', 'percent', 'scale', 'gem', 'gift',

  // entertainment
  'music', 'music-2', 'music-4', 'headphones', 'film', 'tv', 'gamepad-2',
  'joystick', 'dices', 'camera', 'image', 'palette', 'paintbrush', 'theater',
  'drama', 'clapperboard', 'disc', 'guitar', 'piano',

  // nature / weather
  'sun', 'sunrise', 'sunset', 'moon', 'cloud', 'cloud-rain', 'cloud-drizzle',
  'cloud-snow', 'cloud-lightning', 'cloud-fog', 'snowflake', 'leaf',
  'flower', 'flower-2', 'sprout', 'wind', 'rainbow', 'umbrella',
  'thermometer-sun', 'thermometer-snowflake',

  // tools
  'hammer', 'wrench', 'screwdriver', 'scissors', 'paintbrush', 'brush',
  'plug', 'plug-zap', 'battery', 'battery-charging', 'key', 'lock', 'unlock',
  'pickaxe', 'axe', 'shovel', 'saw', 'drill', 'ruler', 'magnet',

  // people / family
  'baby', 'baby-bottle', 'users', 'user', 'user-plus', 'smile', 'laugh',
  'frown', 'angry', 'heart-handshake', 'handshake', 'hand-metal',

  // pets
  'dog', 'cat', 'paw-print', 'bird', 'fish', 'rabbit', 'turtle',

  // events / misc
  'gift', 'party-popper', 'cake', 'crown', 'rocket', 'puzzle', 'target',
  'megaphone', 'bell-ring', 'star', 'badge',

  // tech / device
  'smartphone', 'tablet', 'computer', 'cpu', 'hard-drive', 'usb', 'wifi',
  'bluetooth', 'cable', 'battery', 'power', 'zap',

  // body / care
  'bath', 'hand', 'smile', 'eye', 'ear', 'footprints',

  // clothing
  'shirt', 'glasses', 'crown', 'watch',
];

// Keyword → Lucide icon name. Hand-curated RU + EN pairs, matched per-word
// against the task text. Supports prefix match (word startsWith keyword or
// vice versa) for simple stem tolerance. Expand organically.

const ICON_KEYWORDS = {
  // ---------- shopping ----------
  'магазин': 'shopping-bag', 'покупк': 'shopping-bag', 'купить': 'shopping-bag',
  'купл': 'shopping-bag', 'приобрест': 'shopping-bag',
  'shop': 'shopping-bag', 'buy': 'shopping-bag', 'groceries': 'shopping-cart',
  'продукт': 'shopping-cart', 'корзин': 'shopping-basket', 'заказать': 'package',
  'заказ': 'package', 'доставк': 'package', 'посылк': 'package', 'pack': 'package',
  'маркет': 'store', 'market': 'store', 'супермаркет': 'shopping-cart',

  // ---------- home / household ----------
  'дом': 'home', 'home': 'home', 'house': 'home', 'квартир': 'home', 'жиль': 'home',
  'комнат': 'door-open', 'кухн': 'utensils', 'ванн': 'bath', 'душ': 'shower-head',
  'спальн': 'bed-double', 'кроват': 'bed-double', 'диван': 'sofa',
  'уборк': 'sparkles', 'убрать': 'sparkles', 'убират': 'sparkles', 'clean': 'sparkles',
  'порядок': 'sparkles', 'разобрать': 'sparkles',
  'мыт': 'droplets', 'помыть': 'droplets', 'помыл': 'droplets',
  'пол': 'broom', 'подмест': 'broom', 'пылесос': 'broom',
  'стирк': 'washing-machine', 'постирать': 'washing-machine', 'laundry': 'washing-machine',
  'гладить': 'shirt', 'погладить': 'shirt',
  'посуд': 'utensils-crossed', 'помыть посуду': 'utensils-crossed',
  'мусор': 'trash-2', 'вынести': 'trash-2', 'выкинуть': 'trash-2', 'выбросить': 'trash-2',
  'trash': 'trash-2', 'garbage': 'trash-2',
  'ремонт': 'wrench', 'починить': 'wrench', 'fix': 'wrench', 'repair': 'wrench',
  'лампочк': 'lightbulb', 'свет': 'lightbulb', 'light': 'lightbulb',

  // ---------- work / communication ----------
  'работ': 'briefcase', 'work': 'briefcase', 'job': 'briefcase', 'офис': 'briefcase',
  'встреч': 'users', 'meeting': 'users', 'собес': 'users', 'интервью': 'users',
  'созвон': 'video', 'zoom': 'video', 'видеозвонок': 'video', 'call': 'phone-call',
  'звонок': 'phone', 'позвонить': 'phone', 'набрать': 'phone', 'телефон': 'phone',
  'переговор': 'users', 'discuss': 'users', 'обсуди': 'message-circle',
  'письмо': 'mail', 'email': 'mail', 'почт': 'mail', 'написать': 'mail',
  'ответить': 'mail', 'reply': 'mail', 'mail': 'mail',
  'сообщение': 'message-circle', 'смс': 'message-circle', 'telegram': 'send',
  'whatsapp': 'message-circle', 'слак': 'message-square', 'slack': 'message-square',
  'отчёт': 'file-text', 'отчет': 'file-text', 'report': 'file-text',
  'документ': 'file-text', 'document': 'file-text', 'doc': 'file-text',
  'договор': 'file-text', 'contract': 'file-text', 'подписать': 'signature',
  'задач': 'clipboard', 'task': 'clipboard', 'todo': 'clipboard', 'список': 'clipboard-list',
  'план': 'calendar-check', 'plan': 'calendar-check', 'планир': 'calendar-check',
  'дедлайн': 'calendar-clock', 'deadline': 'calendar-clock', 'срок': 'calendar-clock',
  'идея': 'lightbulb', 'idea': 'lightbulb', 'мысль': 'lightbulb', 'придумать': 'lightbulb',
  'проверить': 'check', 'check': 'check', 'чекнуть': 'check',
  'ноутбук': 'laptop', 'ноут': 'laptop', 'laptop': 'laptop', 'макбук': 'laptop',
  'принтер': 'printer', 'распечатать': 'printer', 'print': 'printer', 'напечатать': 'printer',
  'презент': 'presentation', 'выступ': 'presentation', 'доклад': 'presentation',
  'банк': 'landmark', 'bank': 'landmark',
  'клиент': 'user', 'партнер': 'handshake', 'партнёр': 'handshake',

  // ---------- fitness ----------
  'зал': 'dumbbell', 'спорт': 'dumbbell', 'gym': 'dumbbell', 'тренировк': 'dumbbell',
  'тренир': 'dumbbell', 'workout': 'dumbbell', 'штанг': 'dumbbell',
  'бег': 'footprints', 'run': 'footprints', 'пробежк': 'footprints', 'бегать': 'footprints',
  'велосипед': 'bike', 'велик': 'bike', 'bike': 'bike', 'велопрогулк': 'bike',
  'йога': 'flower', 'yoga': 'flower', 'медитац': 'flower', 'meditation': 'flower',
  'ходьба': 'footprints', 'шаги': 'footprints', 'гулять': 'footprints', 'прогулк': 'footprints',
  'погулять': 'footprints', 'walk': 'footprints',
  'плавание': 'waves', 'плавать': 'waves', 'бассейн': 'waves', 'swim': 'waves',
  'лыжи': 'mountain-snow', 'сноуборд': 'mountain-snow', 'ski': 'mountain-snow',
  'коньки': 'mountain-snow',
  'футбол': 'volleyball', 'теннис': 'target', 'баскетбол': 'volleyball',

  // ---------- health ----------
  'таблетк': 'pill', 'лекарств': 'pill', 'pill': 'pill', 'pills': 'tablets',
  'витамин': 'pill', 'vitamin': 'pill', 'выпить таблетк': 'pill',
  'врач': 'stethoscope', 'доктор': 'stethoscope', 'doctor': 'stethoscope',
  'приём': 'stethoscope', 'прием': 'stethoscope', 'запись к врач': 'stethoscope',
  'больниц': 'hospital', 'hospital': 'hospital', 'клиник': 'hospital',
  'аптек': 'pill', 'pharmacy': 'pill',
  'анализ': 'flask-conical', 'кровь': 'droplet', 'blood': 'droplet',
  'обследован': 'stethoscope', 'checkup': 'stethoscope',
  'укол': 'syringe', 'прививк': 'syringe', 'vaccin': 'syringe',
  'стоматолог': 'tooth', 'зуб': 'tooth', 'dentist': 'tooth',
  'окулист': 'eye', 'зрение': 'eye', 'очки': 'glasses',
  'капли': 'droplet', 'мазь': 'bandage', 'бинт': 'bandage',
  'массаж': 'hand', 'massage': 'hand',
  'температур': 'thermometer', 'горло': 'thermometer',
  'маникюр': 'sparkles', 'педикюр': 'sparkles', 'салон': 'sparkles',
  'стрижк': 'scissors', 'парикмахер': 'scissors', 'постричь': 'scissors',
  'побрить': 'scissors', 'бритьё': 'scissors', 'бороду': 'scissors',

  // ---------- food ----------
  'кофе': 'coffee', 'coffee': 'coffee', 'капучино': 'coffee', 'эспрессо': 'coffee',
  'латте': 'coffee',
  'чай': 'cup-soda', 'tea': 'cup-soda', 'чайник': 'cup-soda',
  'завтрак': 'sandwich', 'breakfast': 'sandwich', 'позавтракать': 'sandwich',
  'обед': 'utensils', 'lunch': 'utensils', 'пообедать': 'utensils',
  'ужин': 'utensils', 'dinner': 'utensils', 'поужинать': 'utensils',
  'еда': 'utensils', 'food': 'utensils', 'есть': 'utensils', 'поест': 'utensils',
  'перекус': 'cookie', 'snack': 'cookie',
  'приготовить': 'chef-hat', 'готовить': 'chef-hat', 'сварить': 'chef-hat',
  'пожарить': 'chef-hat', 'запечь': 'chef-hat', 'cook': 'chef-hat',
  'ресторан': 'utensils', 'кафе': 'coffee', 'столов': 'utensils',
  'бутерброд': 'sandwich', 'сэндвич': 'sandwich',
  'суп': 'soup', 'борщ': 'soup', 'бульон': 'soup', 'soup': 'soup',
  'пицца': 'pizza', 'pizza': 'pizza',
  'салат': 'salad', 'salad': 'salad',
  'суши': 'fish', 'роллы': 'fish', 'рыба': 'fish', 'fish': 'fish',
  'мясо': 'beef', 'стейк': 'beef', 'говядин': 'beef', 'beef': 'beef', 'meat': 'beef',
  'курица': 'drumstick', 'куриц': 'drumstick', 'chicken': 'drumstick',
  'яйц': 'egg', 'egg': 'egg', 'омлет': 'egg-fried',
  'хлеб': 'wheat', 'bread': 'wheat', 'батон': 'wheat',
  'молоко': 'milk', 'milk': 'milk', 'сливки': 'milk', 'йогурт': 'milk', 'творог': 'milk',
  'сыр': 'milk', 'cheese': 'milk',
  'вода': 'droplet', 'water': 'droplet', 'попить': 'cup-soda', 'пить воду': 'droplet',
  'вино': 'wine', 'wine': 'wine',
  'пиво': 'beer', 'beer': 'beer',
  'коктейль': 'martini', 'мартини': 'martini', 'алкоголь': 'wine',
  'торт': 'cake-slice', 'тортик': 'cake-slice', 'cake': 'cake-slice', 'десерт': 'cake-slice',
  'мороженое': 'ice-cream', 'ice cream': 'ice-cream',
  'печенье': 'cookie', 'cookie': 'cookie',
  'шоколад': 'candy', 'конфет': 'candy',
  'яблоко': 'apple', 'apple': 'apple', 'яблок': 'apple',
  'банан': 'banana', 'banana': 'banana',
  'морковь': 'carrot', 'морковк': 'carrot', 'carrot': 'carrot',
  'помидор': 'tomato', 'томат': 'tomato',
  'лимон': 'citrus', 'апельсин': 'citrus', 'мандарин': 'citrus',
  'фрукт': 'apple', 'овощ': 'leafy-green', 'ягод': 'cherry',
  'орех': 'nut', 'nut': 'nut', 'миндаль': 'nut',

  // ---------- travel ----------
  'машин': 'car', 'car': 'car', 'авто': 'car', 'автомобиль': 'car',
  'мото': 'car', 'мотоцикл': 'car',
  'заправк': 'fuel', 'бензин': 'fuel', 'gas': 'fuel', 'fuel': 'fuel',
  'такси': 'car-front', 'taxi': 'car-front', 'uber': 'car-front', 'яндекс такси': 'car-front',
  'самолёт': 'plane', 'самолет': 'plane', 'plane': 'plane', 'flight': 'plane',
  'перелёт': 'plane', 'перелет': 'plane', 'авиа': 'plane',
  'поезд': 'train-front', 'train': 'train-front', 'электричк': 'train-front',
  'метро': 'train-front', 'metro': 'train-front', 'subway': 'train-front',
  'автобус': 'bus', 'bus': 'bus', 'трамвай': 'tram-front', 'маршрутк': 'bus',
  'корабль': 'ship', 'паром': 'ship', 'яхта': 'sailboat', 'лодк': 'sailboat',
  'отпуск': 'plane', 'vacation': 'plane', 'путешеств': 'plane', 'travel': 'plane',
  'поездк': 'map-pinned', 'командировк': 'briefcase', 'отель': 'bed-double', 'hotel': 'bed-double',
  'чемодан': 'luggage', 'багаж': 'luggage', 'luggage': 'luggage', 'рюкзак': 'backpack',
  'билет': 'ticket', 'ticket': 'ticket', 'бронь': 'ticket',

  // ---------- finance ----------
  'деньги': 'wallet', 'money': 'wallet', 'кошел': 'wallet',
  'оплат': 'credit-card', 'заплатить': 'credit-card', 'pay': 'credit-card',
  'перевод': 'banknote', 'транзак': 'banknote', 'transfer': 'banknote',
  'карт': 'credit-card', 'card': 'credit-card',
  'счёт': 'receipt', 'счет': 'receipt', 'bill': 'receipt', 'invoice': 'receipt', 'чек': 'receipt',
  'налог': 'receipt', 'tax': 'receipt', 'ндс': 'receipt',
  'накопить': 'piggy-bank', 'копить': 'piggy-bank', 'save': 'piggy-bank',
  'ипотек': 'landmark', 'кредит': 'credit-card', 'займ': 'banknote',
  'страхов': 'shield', 'insurance': 'shield',
  'инвест': 'trending-up', 'invest': 'trending-up', 'акци': 'trending-up',
  'зарплат': 'banknote', 'зп': 'banknote', 'salary': 'banknote', 'аванс': 'banknote',
  'подписк': 'credit-card', 'subscribe': 'credit-card', 'sub': 'credit-card',
  'бюджет': 'calculator', 'budget': 'calculator', 'расход': 'trending-down', 'доход': 'trending-up',

  // ---------- learning / reading ----------
  'книг': 'book-open', 'book': 'book-open', 'читать': 'book-open', 'прочитать': 'book-open',
  'чтение': 'book-open', 'reading': 'book-open',
  'учёб': 'graduation-cap', 'учеб': 'graduation-cap', 'курс': 'graduation-cap',
  'study': 'graduation-cap', 'обучен': 'graduation-cap', 'изучить': 'graduation-cap',
  'урок': 'book-marked', 'лекц': 'graduation-cap', 'семинар': 'users',
  'записать': 'pencil', 'заметк': 'notebook-pen', 'note': 'pencil', 'notes': 'notebook-pen',
  'блокнот': 'notebook', 'notebook': 'notebook', 'дневник': 'notebook',
  'писать': 'pen', 'write': 'pen',
  'язык': 'language', 'english': 'language', 'английск': 'language', 'немецк': 'language',
  'испанск': 'language', 'француз': 'language', 'китайск': 'language',
  'школ': 'school', 'school': 'school',
  'библиотек': 'library',

  // ---------- family / people ----------
  'лид': 'heart', 'лида': 'heart', 'лиде': 'heart', 'лиды': 'heart', 'лидой': 'heart',
  'лёв': 'baby', 'лев': 'baby', 'лёва': 'baby', 'лева': 'baby',
  'мир': 'baby', 'мира': 'baby',
  'мама': 'heart', 'маме': 'heart', 'мамы': 'heart',
  'папа': 'heart', 'папе': 'heart', 'папы': 'heart',
  'семь': 'heart', 'family': 'heart', 'родные': 'heart',
  'ребёнок': 'baby', 'ребенок': 'baby', 'дети': 'baby', 'baby': 'baby', 'малыш': 'baby',
  'сын': 'baby', 'дочь': 'baby', 'дочк': 'baby',
  'бабушк': 'heart', 'дедушк': 'heart', 'внук': 'baby',
  'брат': 'user', 'сестр': 'user', 'друг': 'user', 'подруг': 'user',
  'коллег': 'users', 'босс': 'user', 'шеф': 'user',
  'тесть': 'user', 'тёщ': 'user', 'свекр': 'user',

  // ---------- pets ----------
  'собак': 'dog', 'пёс': 'dog', 'пес': 'dog', 'dog': 'dog', 'щенок': 'dog',
  'выгулять': 'dog', 'выгул': 'dog', 'гулять с собак': 'dog',
  'кот': 'cat', 'кошк': 'cat', 'cat': 'cat', 'котёнок': 'cat', 'котенок': 'cat',
  'попугай': 'bird', 'птица': 'bird', 'черепах': 'turtle', 'хомяк': 'paw-print',

  // ---------- time ----------
  'будильник': 'alarm-clock', 'встать': 'alarm-clock', 'проснуться': 'alarm-clock',
  'таймер': 'timer', 'секундомер': 'timer',
  'сон': 'bed', 'спать': 'bed', 'sleep': 'bed', 'лечь спать': 'bed', 'nap': 'bed',
  'sleeping': 'bed',

  // ---------- entertainment ----------
  'музык': 'music', 'music': 'music', 'плейлист': 'music', 'песня': 'music', 'song': 'music',
  'концерт': 'music-2', 'слушать': 'headphones', 'подкаст': 'headphones', 'podcast': 'headphones',
  'кино': 'film', 'фильм': 'film', 'movie': 'film', 'сериал': 'tv', 'tv': 'tv',
  'смотреть': 'tv', 'посмотреть': 'tv', 'watch': 'tv',
  'игр': 'gamepad-2', 'game': 'gamepad-2', 'поиграть': 'gamepad-2', 'плейстейшн': 'gamepad-2',
  'фото': 'camera', 'снять': 'camera', 'photo': 'camera', 'сфотографировать': 'camera',
  'селфи': 'camera',
  'рисовать': 'paintbrush', 'нарисовать': 'paintbrush', 'draw': 'paintbrush',

  // ---------- events / misc ----------
  'подарок': 'gift', 'gift': 'gift', 'подарить': 'gift',
  'праздник': 'party-popper', 'вечеринк': 'party-popper', 'тусовк': 'party-popper',
  'party': 'party-popper',
  'днюха': 'cake', 'день рожд': 'cake', 'др ': 'cake', 'birthday': 'cake', 'юбилей': 'cake',
  'свадьб': 'heart', 'годовщин': 'heart',
  'новый год': 'gift', 'нг': 'gift', 'рождеств': 'gift', 'christmas': 'gift',
  'ключ': 'key', 'key': 'key', 'забрать ключи': 'key',
  'зонт': 'umbrella', 'umbrella': 'umbrella',
  'ракет': 'rocket', 'проект': 'rocket', 'project': 'rocket', 'стартап': 'rocket',
  'цель': 'target', 'goal': 'target', 'задач жизни': 'target',
  'напомнить': 'bell', 'напоминан': 'bell', 'reminder': 'bell', 'remind': 'bell',
  'флаг': 'flag', 'отметка': 'flag',

  // ---------- tech / device ----------
  'пк': 'computer', 'компьютер': 'computer', 'комп ': 'computer',
  'монитор': 'monitor', 'экран': 'monitor',
  'наушник': 'headphones', 'headphones': 'headphones',
  'клавиатур': 'keyboard', 'мышка': 'mouse', 'мышь': 'mouse',
  'смартфон': 'smartphone', 'айфон': 'smartphone', 'iphone': 'smartphone',
  'планшет': 'tablet', 'ipad': 'tablet',
  'часы': 'watch', 'apple watch': 'watch',
  'зарядить': 'battery-charging', 'зарядк': 'battery-charging', 'charge': 'battery-charging',
  'кабель': 'cable', 'провод': 'cable', 'розетк': 'plug',
  'wifi': 'wifi', 'вайфай': 'wifi', 'интернет': 'wifi',
  'пароль': 'lock', 'password': 'lock',

  // ---------- weather ----------
  'солнц': 'sun', 'солнечно': 'sun', 'sunny': 'sun',
  'дождь': 'cloud-rain', 'rain': 'cloud-rain',
  'снег': 'snowflake', 'snow': 'snowflake',
  'облачно': 'cloud', 'пасмурно': 'cloud',
  'жарко': 'thermometer-sun', 'холодно': 'thermometer-snowflake',
  'ветер': 'wind', 'ветрено': 'wind', 'wind': 'wind',
  'гроза': 'cloud-lightning', 'молни': 'zap', 'туман': 'cloud-fog',

  // ---------- body / care ----------
  'помыть голов': 'droplets', 'волос': 'scissors',
  'побриться': 'scissors', 'брить': 'scissors',

  // ---------- kids / childcare ----------
  'садик': 'school', 'детсад': 'school', 'ясли': 'baby',
  'забрать из сад': 'school', 'отвести в сад': 'school',
  'кружок': 'graduation-cap', 'секция': 'graduation-cap',
  'уроки': 'book-open', 'домашк': 'book-open', 'домашнее задан': 'book-open',
  'памперс': 'baby', 'подгузник': 'baby', 'бутылочк': 'baby-bottle', 'смесь': 'baby-bottle',
  'прикорм': 'utensils',

  // ---------- clothing ----------
  'одежд': 'shirt', 'футболк': 'shirt', 'джинс': 'shirt', 'куртк': 'shirt',
  'пальто': 'shirt', 'шапк': 'shirt', 'платье': 'shirt', 'свитер': 'shirt',
  'ботинк': 'footprints', 'кроссовк': 'footprints', 'туфли': 'footprints', 'обувь': 'footprints',
};
