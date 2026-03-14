/**
 * Cardiac Risk Screening Tool — Application logic
 * Structured for easy backend integration: replace runLocalAnalysis() with an API call.
 */

(function () {
  'use strict';

  var THEME_KEY = 'heartsync-theme';

  function getTheme() {
    return localStorage.getItem(THEME_KEY) || 'light';
  }

  function setTheme(theme) {
    var root = document.documentElement;
    if (theme === 'dark') {
      root.setAttribute('data-theme', 'dark');
    } else {
      root.removeAttribute('data-theme');
    }
    localStorage.setItem(THEME_KEY, theme);
  }

  function updateDarkModeButton() {
    var btn = document.getElementById('dark-mode-btn');
    if (!btn) return;
    var isDark = getTheme() === 'dark';
    btn.textContent = isDark ? '\u263C' : '\u263E';
    btn.setAttribute('aria-label', isDark ? 'Switch to light mode' : 'Switch to dark mode');
    btn.setAttribute('title', isDark ? 'Switch to light mode' : 'Switch to dark mode');
  }

  if (document.documentElement) {
    if (getTheme() === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
  }

  // --- DOM references (set on init) ---
  var form = null;
  var resultCard = null;
  var resultLevel = null;
  var resultCondition = null;
  var resultRecommendation = null;
  var graphRiskLabel = null;
  var graphEcg = null;
  var graphEcho = null;
  var syncedEcg = false;
  var syncedEcho = false;
  var lastRiskResult = null;

  /**
   * Fake sample data for demo/testing. One male, one female; aligns with REF (μ, σ) and risk thresholds.
   */
  var FAKE_DATA_MALE = {
    age: 48,
    sex: 'male',
    qtInterval: 458,
    qrsVoltage: 1.6,
    stDeviation: 0,
    tWaveInversion: 'none',
    arrhythmiaBurden: 4,
    lvWallThickness: 10,
    lvEjectionFraction: 60,
    wallMotionAbnormality: 'none',
    rvDilation: 'no',
    lvotGradient: 6
  };

  var FAKE_DATA_FEMALE = {
    age: 55,
    sex: 'female',
    qtInterval: 418,
    qrsVoltage: 1.4,
    stDeviation: -0.2,
    tWaveInversion: 'none',
    arrhythmiaBurden: 2,
    lvWallThickness: 8.5,
    lvEjectionFraction: 65,
    wallMotionAbnormality: 'none',
    rvDilation: 'no',
    lvotGradient: 3
  };

  var ECG_FIELDS = ['qtInterval', 'qrsVoltage', 'stDeviation', 'tWaveInversion', 'arrhythmiaBurden'];
  var ECHO_FIELDS = ['lvWallThickness', 'lvEjectionFraction', 'wallMotionAbnormality', 'rvDilation', 'lvotGradient'];

  /**
   * Set only the given form fields from a data object.
   * @param {Object} data - Object keyed by form field names
   * @param {string[]} fieldNames - List of field names to set
   */
  function setFormFields(data, fieldNames) {
    if (!form) return;
    fieldNames.forEach(function (name) {
      var el = form.elements[name];
      if (el && data[name] !== undefined) {
        el.value = String(data[name]);
      }
    });
  }

  /**
   * Get fake data for current sex selection (male → FAKE_DATA_MALE, female → FAKE_DATA_FEMALE).
   */
  function getFakeDataForSex() {
    var sex = (form && form.elements.sex) ? (form.elements.sex.value || '').toLowerCase() : '';
    return sex === 'female' ? FAKE_DATA_FEMALE : FAKE_DATA_MALE;
  }

  /**
   * Collect form data into a single object. Use this payload for backend API.
   * @returns {Object} Form data keyed by field name
   */
  function getFormData() {
    if (!form) return {};
    var raw = new FormData(form);
    var data = {};
    raw.forEach(function (value, key) {
      data[key] = value;
    });
    // Coerce numbers where appropriate (for local logic; backend may expect strings)
    var numericFields = [
      'age', 'qtInterval', 'qrsVoltage', 'stDeviation', 'arrhythmiaBurden',
      'lvWallThickness', 'lvEjectionFraction', 'lvotGradient'
    ];
    numericFields.forEach(function (field) {
      if (data[field] !== undefined && data[field] !== '') {
        var n = Number(data[field]);
        if (!Number.isNaN(n)) data[field] = n;
      }
    });
    return data;
  }

  /**
   * Reference values (μ, σ) from literature for Z-score: Z = (X - μ) / σ.
   * Sources: Cardiovascular health tool doc; PMC10567650 (LVEF); MDPI 2308-3425/9/6/169 (LVT);
   * QT interval is the only metric with sex-specific references (Qt/QTc differs by sex).
   */
  var REF = {
    qtInterval: {
      male:   { mu: 400, sigma: 25 },
      female: { mu: 420, sigma: 25 }
    },
    qrsVoltage:       { mu: 1.5, sigma: 0.6 },
    stDeviation:      { mu: 0, sigma: 0.5 },
    arrhythmiaBurden: { mu: 0, sigma: 8 },
    lvWallThickness:  { mu: 9, sigma: 1.5 },   // doc: normal µ ≈ 9 mm, σ ≈ 1.5 mm; ≥15 mm risk
    lvEjectionFraction: { mu: 62, sigma: 5 },   // doc: normal µ ≈ 62%, σ ≈ 5%; LVEF ≤35% high SCD risk
    lvotGradient:     { mu: 2, sigma: 8 },
    strokeVolume:    { mu: 75, sigma: 15 }    // doc: SV = EDV - ESV; normal ~60–100 mL/beat, µ≈75, σ≈15
  };

  var Z_ABNORMAL = 1; // |Z| >= 1 → abnormal (positive)

  // Research-backed risk thresholds (document)
  var RISK = {
    lvEfHighScd: 35,   // LVEF ≤ 35% → high risk for SCD
    lvWallDeath: 15    // LVT ≥ 15 mm → risk of cardiac death
  };

  function zScore(x, mu, sigma) {
    if (sigma <= 0 || typeof x !== 'number' || Number.isNaN(x)) return null;
    return (x - mu) / sigma;
  }

  /**
   * Risk analysis using Z-scores. Outcome Positive/Negative is determined by
   * Z = (X - μ) / σ with μ, σ from literature. QT interval uses sex-specific μ, σ.
   * @param {Object} data - Form data from getFormData()
   * @returns {Object} { score, level, condition, recommendation }
   */
  function runLocalAnalysis(data) {
    var sex = (data.sex || '').toLowerCase();
    var qtInterval = data.qtInterval;
    var qrsVoltage = data.qrsVoltage;
    var stDeviation = data.stDeviation;
    var arrhythmia = Number(data.arrhythmiaBurden);
    var lvWall = data.lvWallThickness;
    var lvEf = data.lvEjectionFraction;
    var lvotGradient = data.lvotGradient;
    var tWave = (data.tWaveInversion || 'none');
    var wallMotion = (data.wallMotionAbnormality || 'none');
    var rvDilation = (data.rvDilation || 'no');

    var zScores = {};
    var abnormal = [];

    // QT Interval: sex-specific μ, σ
    if (typeof qtInterval === 'number' && !Number.isNaN(qtInterval)) {
      var qtRef = sex === 'female' ? REF.qtInterval.female : REF.qtInterval.male;
      var zQt = zScore(qtInterval, qtRef.mu, qtRef.sigma);
      if (zQt !== null) {
        zScores.qtInterval = zQt;
        if (Math.abs(zQt) >= Z_ABNORMAL) abnormal.push('qtInterval');
      }
    }

    // Remaining metrics: same μ, σ for all
    if (typeof qrsVoltage === 'number' && !Number.isNaN(qrsVoltage)) {
      var zQrs = zScore(qrsVoltage, REF.qrsVoltage.mu, REF.qrsVoltage.sigma);
      if (zQrs !== null) {
        zScores.qrsVoltage = zQrs;
        if (Math.abs(zQrs) >= Z_ABNORMAL) abnormal.push('qrsVoltage');
      }
    }
    if (typeof stDeviation === 'number' && !Number.isNaN(stDeviation)) {
      var zSt = zScore(stDeviation, REF.stDeviation.mu, REF.stDeviation.sigma);
      if (zSt !== null) {
        zScores.stDeviation = zSt;
        if (Math.abs(zSt) >= Z_ABNORMAL) abnormal.push('stDeviation');
      }
    }
    if (typeof arrhythmia === 'number' && !Number.isNaN(arrhythmia)) {
      var zAr = zScore(arrhythmia, REF.arrhythmiaBurden.mu, REF.arrhythmiaBurden.sigma);
      if (zAr !== null) {
        zScores.arrhythmiaBurden = zAr;
        if (Math.abs(zAr) >= Z_ABNORMAL) abnormal.push('arrhythmiaBurden');
      }
    }
    if (typeof lvWall === 'number' && !Number.isNaN(lvWall)) {
      var zLv = zScore(lvWall, REF.lvWallThickness.mu, REF.lvWallThickness.sigma);
      if (zLv !== null) {
        zScores.lvWallThickness = zLv;
        if (Math.abs(zLv) >= Z_ABNORMAL || lvWall >= RISK.lvWallDeath) abnormal.push('lvWallThickness');
      }
    }
    if (typeof lvEf === 'number' && !Number.isNaN(lvEf)) {
      var zEf = zScore(lvEf, REF.lvEjectionFraction.mu, REF.lvEjectionFraction.sigma);
      if (zEf !== null) {
        zScores.lvEjectionFraction = zEf;
        if (Math.abs(zEf) >= Z_ABNORMAL || lvEf <= RISK.lvEfHighScd) abnormal.push('lvEjectionFraction');
      }
    }
    if (typeof lvotGradient === 'number' && !Number.isNaN(lvotGradient)) {
      var zLvot = zScore(lvotGradient, REF.lvotGradient.mu, REF.lvotGradient.sigma);
      if (zLvot !== null) {
        zScores.lvotGradient = zLvot;
        if (Math.abs(zLvot) >= Z_ABNORMAL) abnormal.push('lvotGradient');
      }
    }

    // Outcome: Positive if any |Z| >= 1, else Negative (formula-based)
    var level = abnormal.length > 0 ? 'High' : 'Low';
    var score = abnormal.length > 0 ? Math.min(100, 50 + abnormal.length * 15) : Math.max(0, 25 - Object.keys(zScores).length);

    var condition = '—';
    var recommendation = '—';

    if (level === 'High') {
      if (abnormal.indexOf('lvWallThickness') >= 0 || abnormal.indexOf('lvotGradient') >= 0) {
        condition = 'Hypertrophic Cardiomyopathy';
        recommendation = 'Cardiology evaluation and risk stratification recommended. Consider genetic counseling.';
      } else if (abnormal.indexOf('lvEjectionFraction') >= 0) {
        condition = 'Dilated Cardiomyopathy / Severe LV Dysfunction';
        recommendation = 'Cardiology evaluation recommended. Consider ICD discussion.';
      } else if (abnormal.indexOf('qtInterval') >= 0) {
        condition = 'Long QT Syndrome';
        recommendation = 'Cardiology evaluation and ECG monitoring recommended.';
      } else {
        condition = 'Multiple risk factors';
        recommendation = 'Cardiology evaluation recommended.';
      }
    } else {
      condition = 'No high-risk features identified';
      recommendation = 'Routine follow-up as clinically indicated.';
    }

    return {
      score: score,
      level: level,
      condition: condition,
      recommendation: recommendation
    };
  }

  /**
   * Draw a single metric row (label + value only). unit is string (e.g. 'ms', '%').
   */
  function renderValueRow(label, value, unit) {
    var num = Number(value);
    var text = (typeof value === 'number' && !Number.isNaN(num))
      ? num + (unit || '') : '—';
    return (
      '<div class="graph-value-row">' +
        '<span class="bar-row-label">' + label + '</span>' +
        '<span class="graph-value-label">' + text + '</span>' +
      '</div>'
    );
  }

  /**
   * Update graphs panel from form data and optional risk result (after Analyze).
   * ECG and Echo metrics only appear after the user has clicked the corresponding Sync button.
   * @param {Object} data - Form data from getFormData()
   * @param {Object|null} riskResult - { level } from analysis, or null if not yet analyzed
   */
  function updateGraphs(data, riskResult) {
    if (!graphEcg || !graphEcho) return;

    if (graphRiskLabel) {
      var res = riskResult || lastRiskResult;
      if (res && res.level) {
        var level = res.level.toLowerCase();
        graphRiskLabel.textContent = level === 'low' ? 'Negative' : 'Positive';
        graphRiskLabel.className = 'risk-score-value risk-score-value--' + (level === 'low' ? 'negative' : 'positive');
      } else {
        graphRiskLabel.textContent = '—';
        graphRiskLabel.className = 'risk-score-value';
      }
    }

    var qt = data.qtInterval;
    var qrs = data.qrsVoltage;
    var st = data.stDeviation;
    var arrh = data.arrhythmiaBurden;
    var lvWall = data.lvWallThickness;
    var lvEf = data.lvEjectionFraction;
    var lvot = data.lvotGradient;

    if (syncedEcg) {
      graphEcg.innerHTML =
        renderValueRow('QT Interval', qt, ' ms') +
        renderValueRow('QRS Voltage', qrs, ' mV') +
        renderValueRow('ST Deviation', st, ' mm') +
        renderValueRow('Arrhythmia Burden', arrh, '%');
    } else {
      graphEcg.innerHTML = '<p class="graph-sync-placeholder">Sync ECG Data to show metrics</p>';
    }

    if (syncedEcho) {
      graphEcho.innerHTML =
        renderValueRow('LV Wall Thickness', lvWall, ' mm') +
        renderValueRow('LV Ejection Fraction', lvEf, '%') +
        renderValueRow('LVOT Gradient', lvot, ' mmHg');
    } else {
      graphEcho.innerHTML = '<p class="graph-sync-placeholder">Sync Echocardiography Data to show metrics</p>';
    }
  }

  /**
   * Render analysis result into the result card and show it.
   * @param {Object} result - { score, level, condition, recommendation }
   */
  function showResult(result) {
    if (!resultCard || !resultLevel || !resultCondition || !resultRecommendation) return;

    resultLevel.textContent = result.level;
    resultLevel.className = 'result-value result-value--level risk-' + result.level.toLowerCase();
    resultCondition.textContent = result.condition;
    resultRecommendation.textContent = result.recommendation;

    resultCard.classList.remove('result-card--hidden');
    resultCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    lastRiskResult = result;
    updateGraphs(getFormData(), result);
  }

  /**
   * Analyze risk: get form data, run analysis (local or API), show result.
   */
  function handleSubmit(event) {
    event.preventDefault();
    var data = getFormData();

    // Option A: Local placeholder analysis (current)
    var result = runLocalAnalysis(data);
    showResult(result);

    // Option B: Backend integration — uncomment and replace Option A:
    // fetch('/api/analyze', {
    //   method: 'POST',
    //   headers: { 'Content-Type': 'application/json' },
    //   body: JSON.stringify(data)
    // })
    //   .then(function (res) { return res.json(); })
    //   .then(showResult)
    //   .catch(function (err) {
    //     showResult({ score: '—', level: 'Error', condition: '—', recommendation: 'Unable to analyze. Please try again.' });
    //   });
  }

  /**
   * Bind DOM, form submit, and form input/change to update graphs.
   */
  function init() {
    form = document.getElementById('screening-form');
    resultCard = document.getElementById('result-card');
    resultLevel = document.getElementById('result-level');
    resultCondition = document.getElementById('result-condition');
    resultRecommendation = document.getElementById('result-recommendation');
    graphRiskLabel = document.getElementById('graph-risk-label');
    graphEcg = document.getElementById('graph-ecg');
    graphEcho = document.getElementById('graph-echo');

    if (form) {
      form.addEventListener('submit', handleSubmit);
      form.addEventListener('input', function () { updateGraphs(getFormData(), null); });
      form.addEventListener('change', function () { updateGraphs(getFormData(), null); });
    }

    var ecgFields = document.getElementById('ecg-fields');
    var echoFields = document.getElementById('echo-fields');

    var btnSyncEcg = document.getElementById('btn-sync-ecg');
    if (btnSyncEcg) {
      btnSyncEcg.addEventListener('click', function () {
        setFormFields(getFakeDataForSex(), ECG_FIELDS);
        syncedEcg = true;
        if (ecgFields) ecgFields.classList.remove('form-fields--hidden');
        updateGraphs(getFormData(), lastRiskResult);
      });
    }

    var btnSyncEcho = document.getElementById('btn-sync-echo');
    if (btnSyncEcho) {
      btnSyncEcho.addEventListener('click', function () {
        setFormFields(getFakeDataForSex(), ECHO_FIELDS);
        syncedEcho = true;
        if (echoFields) echoFields.classList.remove('form-fields--hidden');
        updateGraphs(getFormData(), lastRiskResult);
      });
    }

    updateGraphs(getFormData(), null);

    var darkModeBtn = document.getElementById('dark-mode-btn');
    if (darkModeBtn) {
      updateDarkModeButton();
      darkModeBtn.addEventListener('click', function () {
        var next = getTheme() === 'dark' ? 'light' : 'dark';
        setTheme(next);
        updateDarkModeButton();
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
