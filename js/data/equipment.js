// Тренажёры и инвентарь. Фото — Wikimedia Commons, авторы и лицензии в CREDITS.md.

export const EQUIPMENT_GROUPS = [
  { key: 'free', title: 'Свободные веса и скамьи' },
  { key: 'legs', title: 'Тренажёры для ног' },
  { key: 'back', title: 'Спина и турники' },
  { key: 'upper', title: 'Грудь, плечи, руки' },
  { key: 'cardio', title: 'Кардио' },
];

export const EQUIPMENT = [
  { id: 'barbell', group: 'free', name: 'Штанга', hint: 'Олимпийский гриф и блины' },
  { id: 'ezbar', group: 'free', name: 'EZ-гриф', hint: 'Изогнутый гриф для рук' },
  { id: 'dumbbells', group: 'free', name: 'Гантели', hint: 'Ряд гантелей разного веса' },
  { id: 'kettlebell', group: 'free', name: 'Гири', hint: '' },
  { id: 'bench', group: 'free', name: 'Скамья для жима', hint: 'Горизонтальная, со стойками' },
  { id: 'adjbench', group: 'free', name: 'Регулируемая скамья', hint: 'Меняется угол наклона' },
  { id: 'rack', group: 'free', name: 'Силовая рама', hint: 'Стойки для приседаний' },
  { id: 'smith', group: 'free', name: 'Машина Смита', hint: 'Гриф на направляющих' },

  { id: 'legpress', group: 'legs', name: 'Жим ногами', hint: 'Платформа под углом' },
  { id: 'hack', group: 'legs', name: 'Гакк-машина', hint: 'Приседания с упором в плечи' },
  { id: 'legext', group: 'legs', name: 'Разгибание ног', hint: 'Тренажёр на квадрицепс' },
  { id: 'legcurl', group: 'legs', name: 'Сгибание ног', hint: 'Тренажёр на бицепс бедра' },
  { id: 'calf', group: 'legs', name: 'Тренажёр для икр', hint: 'Подъёмы на носки' },
  { id: 'abductor', group: 'legs', name: 'Отведение ног', hint: 'Тренажёр на ягодицы' },
  { id: 'hyperext', group: 'legs', name: 'Гиперэкстензия', hint: 'Поясница и ягодицы' },

  { id: 'latpull', group: 'back', name: 'Верхний блок', hint: 'Тяга к груди' },
  { id: 'cablerow', group: 'back', name: 'Нижний блок', hint: 'Горизонтальная тяга сидя' },
  { id: 'tbar', group: 'back', name: 'Т-гриф', hint: 'Тяга в наклоне' },
  { id: 'gravitron', group: 'back', name: 'Гравитрон', hint: 'Подтягивания с помощью' },
  { id: 'pullupbar', group: 'back', name: 'Турник', hint: '' },

  { id: 'chestpress', group: 'upper', name: 'Жим от груди', hint: 'Тренажёр для груди' },
  { id: 'pecdeck', group: 'upper', name: 'Бабочка', hint: 'Сведение рук (пек-дек)' },
  { id: 'shoulderpress', group: 'upper', name: 'Жим вверх', hint: 'Тренажёр для плеч' },
  { id: 'crossover', group: 'upper', name: 'Кроссовер', hint: 'Блочная рама с тросами' },
  { id: 'dips', group: 'upper', name: 'Брусья', hint: '' },
  { id: 'preacher', group: 'upper', name: 'Скамья Скотта', hint: 'Сгибания на бицепс' },
  { id: 'captain', group: 'upper', name: 'Римский стул', hint: 'Подъём ног в упоре' },

  { id: 'treadmill', group: 'cardio', name: 'Беговая дорожка', hint: '' },
  { id: 'bike', group: 'cardio', name: 'Велотренажёр', hint: '' },
  { id: 'elliptical', group: 'cardio', name: 'Эллипс', hint: '' },
  { id: 'rower', group: 'cardio', name: 'Гребной тренажёр', hint: '' },
];

export const EQUIPMENT_BY_ID = Object.fromEntries(EQUIPMENT.map((e) => [e.id, e]));

export const equipmentImage = (id) => `img/equipment/${id}.jpg`;

export const EQUIPMENT_PRESETS = [
  { key: 'typical', title: 'Обычный зал', ids: ['barbell', 'ezbar', 'dumbbells', 'bench', 'adjbench', 'rack', 'smith', 'legpress', 'legext', 'legcurl', 'hyperext', 'latpull', 'cablerow', 'crossover', 'chestpress', 'pecdeck', 'pullupbar', 'dips', 'treadmill', 'bike', 'elliptical'] },
  { key: 'all', title: 'Есть всё', ids: EQUIPMENT.map((e) => e.id) },
  { key: 'home', title: 'Дома: гантели', ids: ['dumbbells', 'adjbench', 'pullupbar'] },
  { key: 'none', title: 'Ничего нет', ids: [] },
];
