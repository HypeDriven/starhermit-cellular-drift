/*
 * Cellular Drift — strings for the Graphics settings panel in every supported
 * locale. The locale follows navigator.language (exact tag, then language).
 */

const en = {
  graphics: 'Graphics', settingsTitle: 'Graphics settings', back: 'Back',
  quality: 'Quality', auto: 'Auto (detected: {tier})',
  low: 'Low', balanced: 'Balanced', high: 'High', ultra: 'Ultra',
  renderScale: 'Render scale', fromPreset: 'From preset ({tier})',
  adaptive: 'Adaptive resolution', showFps: 'Show frame rate',
  cat_shadows: 'Shadows', cat_bloom: 'Glow (bloom)', cat_grade: 'Color grade & vignette', cat_antialias: 'Anti-aliasing',
  cat_reflections: 'Reflections', cat_particles: 'Particles', cat_background: 'Dish shimmer', cat_detail: 'Surface detail',
  t_off: 'Off', t_on: 'On', t_low: 'Low', t_medium: 'Medium', t_high: 'High',
  t_fxaa: 'FXAA', t_smaa: 'SMAA', t_msaa: 'MSAA', t_static: 'Static', t_animated: 'Animated', t_plain: 'Plain', t_detailed: 'Detailed',
  s_shadows: '{n}² shadows', s_noShadows: 'no shadows', s_bloom: 'glow', s_grade: 'grade', s_reflections: 'reflections', s_noAA: 'no anti-aliasing',
  postFailed: 'Post-processing is unavailable on this device, so glow, color grade and FXAA/SMAA are off.',
  unknownGpu: 'unknown GPU'
};

const STRINGS = {
  'en-US': en,
  'en-GB': Object.assign({}, en, {
    cat_grade: 'Colour grade & vignette', s_grade: 'grade',
    postFailed: 'Post-processing is unavailable on this device, so glow, colour grade and FXAA/SMAA are off.'
  }),
  'es-419': {
    graphics: 'Gráficos', settingsTitle: 'Configuración de gráficos', back: 'Volver',
    quality: 'Calidad', auto: 'Automática (detectada: {tier})',
    low: 'Baja', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra',
    renderScale: 'Escala de renderizado', fromPreset: 'Según el ajuste ({tier})',
    adaptive: 'Resolución adaptativa', showFps: 'Mostrar fotogramas por segundo',
    cat_shadows: 'Sombras', cat_bloom: 'Resplandor (bloom)', cat_grade: 'Corrección de color y viñeta', cat_antialias: 'Antialiasing',
    cat_reflections: 'Reflejos', cat_particles: 'Partículas', cat_background: 'Destellos del cultivo', cat_detail: 'Detalle de superficies',
    t_off: 'No', t_on: 'Sí', t_low: 'Bajas', t_medium: 'Medias', t_high: 'Altas',
    t_fxaa: 'FXAA', t_smaa: 'SMAA', t_msaa: 'MSAA', t_static: 'Estáticos', t_animated: 'Animados', t_plain: 'Simple', t_detailed: 'Detallado',
    s_shadows: 'sombras {n}²', s_noShadows: 'sin sombras', s_bloom: 'resplandor', s_grade: 'color', s_reflections: 'reflejos', s_noAA: 'sin antialiasing',
    postFailed: 'El posprocesado no está disponible en este dispositivo: el resplandor, la corrección de color y FXAA/SMAA están desactivados.',
    unknownGpu: 'GPU desconocida'
  },
  'es-ES': {
    graphics: 'Gráficos', settingsTitle: 'Ajustes gráficos', back: 'Volver',
    quality: 'Calidad', auto: 'Automática (detectada: {tier})',
    low: 'Baja', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra',
    renderScale: 'Escala de renderizado', fromPreset: 'Según el preajuste ({tier})',
    adaptive: 'Resolución adaptativa', showFps: 'Mostrar fotogramas por segundo',
    cat_shadows: 'Sombras', cat_bloom: 'Resplandor (bloom)', cat_grade: 'Etalonaje y viñeta', cat_antialias: 'Suavizado de bordes',
    cat_reflections: 'Reflejos', cat_particles: 'Partículas', cat_background: 'Destellos de la placa', cat_detail: 'Detalle de superficies',
    t_off: 'No', t_on: 'Sí', t_low: 'Bajas', t_medium: 'Medias', t_high: 'Altas',
    t_fxaa: 'FXAA', t_smaa: 'SMAA', t_msaa: 'MSAA', t_static: 'Estáticos', t_animated: 'Animados', t_plain: 'Simple', t_detailed: 'Detallado',
    s_shadows: 'sombras {n}²', s_noShadows: 'sin sombras', s_bloom: 'resplandor', s_grade: 'etalonaje', s_reflections: 'reflejos', s_noAA: 'sin suavizado',
    postFailed: 'El posprocesado no está disponible en este dispositivo: el resplandor, el etalonaje y FXAA/SMAA están desactivados.',
    unknownGpu: 'GPU desconocida'
  },
  'de-DE': {
    graphics: 'Grafik', settingsTitle: 'Grafikeinstellungen', back: 'Zurück',
    quality: 'Qualität', auto: 'Automatisch (erkannt: {tier})',
    low: 'Niedrig', balanced: 'Ausgewogen', high: 'Hoch', ultra: 'Ultra',
    renderScale: 'Renderskalierung', fromPreset: 'Laut Voreinstellung ({tier})',
    adaptive: 'Adaptive Auflösung', showFps: 'Bildrate anzeigen',
    cat_shadows: 'Schatten', cat_bloom: 'Leuchten (Bloom)', cat_grade: 'Farbkorrektur & Vignette', cat_antialias: 'Kantenglättung',
    cat_reflections: 'Spiegelungen', cat_particles: 'Partikel', cat_background: 'Schimmer der Schale', cat_detail: 'Oberflächendetails',
    t_off: 'Aus', t_on: 'An', t_low: 'Niedrig', t_medium: 'Mittel', t_high: 'Hoch',
    t_fxaa: 'FXAA', t_smaa: 'SMAA', t_msaa: 'MSAA', t_static: 'Statisch', t_animated: 'Animiert', t_plain: 'Schlicht', t_detailed: 'Detailliert',
    s_shadows: '{n}²-Schatten', s_noShadows: 'keine Schatten', s_bloom: 'Leuchten', s_grade: 'Farbkorrektur', s_reflections: 'Spiegelungen', s_noAA: 'keine Kantenglättung',
    postFailed: 'Nachbearbeitung ist auf diesem Gerät nicht verfügbar, daher sind Leuchten, Farbkorrektur und FXAA/SMAA aus.',
    unknownGpu: 'unbekannte GPU'
  },
  'fr-FR': {
    graphics: 'Graphismes', settingsTitle: 'Paramètres graphiques', back: 'Retour',
    quality: 'Qualité', auto: 'Auto (détectée : {tier})',
    low: 'Basse', balanced: 'Équilibrée', high: 'Haute', ultra: 'Ultra',
    renderScale: 'Échelle de rendu', fromPreset: 'Selon le préréglage ({tier})',
    adaptive: 'Résolution adaptative', showFps: 'Afficher les images par seconde',
    cat_shadows: 'Ombres', cat_bloom: 'Halo lumineux (bloom)', cat_grade: 'Étalonnage et vignettage', cat_antialias: 'Anticrénelage',
    cat_reflections: 'Reflets', cat_particles: 'Particules', cat_background: 'Miroitement de la boîte', cat_detail: 'Détail des surfaces',
    t_off: 'Désactivé', t_on: 'Activé', t_low: 'Basses', t_medium: 'Moyennes', t_high: 'Hautes',
    t_fxaa: 'FXAA', t_smaa: 'SMAA', t_msaa: 'MSAA', t_static: 'Statique', t_animated: 'Animé', t_plain: 'Simple', t_detailed: 'Détaillé',
    s_shadows: 'ombres {n}²', s_noShadows: 'sans ombres', s_bloom: 'halo', s_grade: 'étalonnage', s_reflections: 'reflets', s_noAA: 'sans anticrénelage',
    postFailed: 'Le post-traitement n’est pas disponible sur cet appareil : le halo, l’étalonnage et FXAA/SMAA sont désactivés.',
    unknownGpu: 'GPU inconnu'
  },
  'fr-CA': {
    graphics: 'Graphismes', settingsTitle: 'Paramètres graphiques', back: 'Retour',
    quality: 'Qualité', auto: 'Auto (détectée : {tier})',
    low: 'Basse', balanced: 'Équilibrée', high: 'Haute', ultra: 'Ultra',
    renderScale: 'Échelle de rendu', fromPreset: 'Selon le préréglage ({tier})',
    adaptive: 'Résolution adaptative', showFps: 'Afficher la fréquence d’images',
    cat_shadows: 'Ombres', cat_bloom: 'Lueur (bloom)', cat_grade: 'Correction des couleurs et vignette', cat_antialias: 'Anticrénelage',
    cat_reflections: 'Reflets', cat_particles: 'Particules', cat_background: 'Miroitement du pétri', cat_detail: 'Détail des surfaces',
    t_off: 'Désactivé', t_on: 'Activé', t_low: 'Basses', t_medium: 'Moyennes', t_high: 'Hautes',
    t_fxaa: 'FXAA', t_smaa: 'SMAA', t_msaa: 'MSAA', t_static: 'Statique', t_animated: 'Animé', t_plain: 'Simple', t_detailed: 'Détaillé',
    s_shadows: 'ombres {n}²', s_noShadows: 'sans ombres', s_bloom: 'lueur', s_grade: 'couleurs', s_reflections: 'reflets', s_noAA: 'sans anticrénelage',
    postFailed: 'Le post-traitement n’est pas offert sur cet appareil : la lueur, la correction des couleurs et FXAA/SMAA sont désactivées.',
    unknownGpu: 'GPU inconnu'
  },
  'pt-BR': {
    graphics: 'Gráficos', settingsTitle: 'Configurações gráficas', back: 'Voltar',
    quality: 'Qualidade', auto: 'Automática (detectada: {tier})',
    low: 'Baixa', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra',
    renderScale: 'Escala de renderização', fromPreset: 'Conforme a predefinição ({tier})',
    adaptive: 'Resolução adaptável', showFps: 'Mostrar taxa de quadros',
    cat_shadows: 'Sombras', cat_bloom: 'Brilho (bloom)', cat_grade: 'Correção de cor e vinheta', cat_antialias: 'Antisserrilhamento',
    cat_reflections: 'Reflexos', cat_particles: 'Partículas', cat_background: 'Cintilação da placa', cat_detail: 'Detalhe das superfícies',
    t_off: 'Desligado', t_on: 'Ligado', t_low: 'Baixas', t_medium: 'Médias', t_high: 'Altas',
    t_fxaa: 'FXAA', t_smaa: 'SMAA', t_msaa: 'MSAA', t_static: 'Estática', t_animated: 'Animada', t_plain: 'Simples', t_detailed: 'Detalhado',
    s_shadows: 'sombras {n}²', s_noShadows: 'sem sombras', s_bloom: 'brilho', s_grade: 'cor', s_reflections: 'reflexos', s_noAA: 'sem antisserrilhamento',
    postFailed: 'O pós-processamento não está disponível neste dispositivo; brilho, correção de cor e FXAA/SMAA estão desligados.',
    unknownGpu: 'GPU desconhecida'
  },
  'it-IT': {
    graphics: 'Grafica', settingsTitle: 'Impostazioni grafiche', back: 'Indietro',
    quality: 'Qualità', auto: 'Automatica (rilevata: {tier})',
    low: 'Bassa', balanced: 'Bilanciata', high: 'Alta', ultra: 'Ultra',
    renderScale: 'Scala di rendering', fromPreset: 'Dal preset ({tier})',
    adaptive: 'Risoluzione adattiva', showFps: 'Mostra frequenza fotogrammi',
    cat_shadows: 'Ombre', cat_bloom: 'Bagliore (bloom)', cat_grade: 'Correzione colore e vignettatura', cat_antialias: 'Antialiasing',
    cat_reflections: 'Riflessi', cat_particles: 'Particelle', cat_background: 'Scintillio della piastra', cat_detail: 'Dettaglio superfici',
    t_off: 'No', t_on: 'Sì', t_low: 'Basse', t_medium: 'Medie', t_high: 'Alte',
    t_fxaa: 'FXAA', t_smaa: 'SMAA', t_msaa: 'MSAA', t_static: 'Statico', t_animated: 'Animato', t_plain: 'Semplice', t_detailed: 'Dettagliato',
    s_shadows: 'ombre {n}²', s_noShadows: 'senza ombre', s_bloom: 'bagliore', s_grade: 'colore', s_reflections: 'riflessi', s_noAA: 'senza antialiasing',
    postFailed: 'La post-elaborazione non è disponibile su questo dispositivo: bagliore, correzione colore e FXAA/SMAA sono disattivati.',
    unknownGpu: 'GPU sconosciuta'
  }
};

export const LOCALES = Object.keys(STRINGS);

const BY_LANGUAGE = { en: 'en-US', es: 'es-419', de: 'de-DE', fr: 'fr-FR', pt: 'pt-BR', it: 'it-IT' };

export function pickLocale(tag) {
  const t = String(tag || '');
  const exact = LOCALES.find((l) => l.toLowerCase() === t.toLowerCase());
  if (exact) return exact;
  if (/^es-es$/i.test(t)) return 'es-ES';
  if (/^en-(gb|au|nz|ie|in|za)$/i.test(t)) return 'en-GB';
  if (/^fr-ca$/i.test(t)) return 'fr-CA';
  return BY_LANGUAGE[t.slice(0, 2).toLowerCase()] || 'en-US';
}

/** Returns t(key, vars) for the given (or browser) locale, falling back to English. */
export function gfxStrings(tag) {
  const loc = pickLocale(tag || (typeof navigator !== 'undefined' ? navigator.language : 'en-US'));
  const table = STRINGS[loc];
  const t = (k, vars) => {
    let s = table[k] != null ? table[k] : en[k] != null ? en[k] : k;
    if (vars) for (const v in vars) s = s.replace('{' + v + '}', vars[v]);
    return s;
  };
  t.locale = loc;
  return t;
}

export { STRINGS };
