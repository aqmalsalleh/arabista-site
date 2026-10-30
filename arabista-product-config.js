/* Shared, pure product options and fit rules. No network, credentials or writes.
 * This module is also shipped to the dashboard and staging storefront. */
(function (root) {
  'use strict';
  var C = {};
  C.key = function (productId) { return 'product_config:' + productId; };
  C.clone = function (value) { return JSON.parse(JSON.stringify(value)); };
  C.fail = function (message) { var e = new Error(message); e.code = 'PRODUCT_CONFIG_INVALID'; throw e; };
  C.text = function (value, label, max) {
    if (typeof value !== 'string' || !value.trim() || value.length > max) C.fail(label + ' is required and must be at most ' + max + ' characters.');
    return value.trim();
  };
  C.number = function (value, label, min, max, optional) {
    if (optional && (value === '' || value === null || value === undefined)) return null;
    if (value === '' || value === null || value === undefined || !Number.isFinite(Number(value)) || Number(value) < min || Number(value) > max) C.fail(label + ' must be between ' + min + ' and ' + max + '.');
    return Number(value);
  };
  C.options = function (config, key) { return config.attributes.filter(function (a) { return a.key === key; })[0].values; };
  C.label = function (config, key, id) { var v = C.options(config, key).filter(function (o) { return o.id === id; })[0]; return v ? v.label : id; };
  C.defaults = function (productCode, profiles) {
    var sizes = profiles.length ? profiles[0].sizes.map(function (r) { return r.size; }) : ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL'];
    var standard = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL'];
    return {
      version: 1, productCode: productCode, revision: 0, updatedAt: '',
      attributes: [
        { key: 'length', label: 'Length', values: profiles.map(function (p) { return { id: p.setCode, label: p.label }; }) },
        { key: 'size', label: 'Size', values: sizes.map(function (s) { return { id: s, label: s }; }) },
        { key: 'colour', label: 'Colour', values: [] }
      ],
      profiles: profiles.map(function (p) {
        return { setCode: p.setCode, recommend: productCode === 'D06' && ['S1', 'S2'].indexOf(p.setCode) >= 0,
          sizes: p.sizes.map(function (r) {
            var row = C.clone(r), split = r.size === 'XS' || r.size === 'S' ? 156 : r.size === 'M' ? 159 : 160;
            row.fitMinCm = p.setCode === 'S1' ? 150 : split;
            row.fitMaxCm = p.setCode === 'S1' ? split : 167;
            row.fitMinExclusive = p.setCode !== 'S1';
            return row;
          }) };
      }),
      fit: {
        enabled: productCode === 'D06',
        rows: sizes.map(function (s) {
          var i = standard.indexOf(s);
          return { size: s, maxWeightKg: i < 0 ? null : [50, 57, 64, 71, 78, 85, 95][i], weightMaxExclusive: i === 0,
            maxBmi: i < 0 ? null : [19.53, 22.27, 25, 27.73, 30.47, 33.2, null][i],
            adjustUpKg: i < 0 ? null : [48, 56, 63, 70, 77, 84, null][i],
            adjustDownKg: i < 0 ? null : [null, 51, 59, 66, 73, 80, 87][i],
            bodyBustIn: i < 0 ? null : [36, 38, 40, 42, 44, 46, 50][i] };
        }),
        heightFloors: productCode === 'D06' ? [{ fromCm: 163, exclusive: true, size: 'M' }, { fromCm: 166, exclusive: false, size: 'L' }] : []
      }
    };
  };
  C.normalize = function (raw, productCode) {
    if (!raw || raw.version !== 1 || raw.productCode !== productCode || !Array.isArray(raw.attributes) || raw.attributes.length !== 3) C.fail('Invalid product configuration.');
    var result = { version: 1, productCode: productCode, attributes: [], profiles: [], fit: { enabled: !!(raw.fit && raw.fit.enabled), rows: [], heightFloors: [] } };
    ['length', 'size', 'colour'].forEach(function (key) {
      var attr = raw.attributes.filter(function (a) { return a && a.key === key; });
      if (attr.length !== 1 || !Array.isArray(attr[0].values) || attr[0].values.length > 30 || (key !== 'colour' && !attr[0].values.length)) C.fail('Add between 1 and 30 ' + key + ' options. Colour may be empty.');
      var seen = Object.create(null), labels = Object.create(null);
      result.attributes.push({ key: key, label: C.text(attr[0].label, 'Variation name', 50), values: attr[0].values.map(function (o) {
        var id = C.text(o && o.id, 'Option code', 24), label = C.text(o && o.label, 'Option name', 50);
        if (!/^[A-Z0-9][A-Z0-9_-]*$/.test(id) || seen[id] || labels[label.toLowerCase()]) C.fail('Option codes and names must be unique. Codes use uppercase letters, numbers, - or _.');
        seen[id] = true; labels[label.toLowerCase()] = true; return { id: id, label: label };
      }) });
    });
    var sizeIds = C.options(result, 'size').map(function (v) { return v.id; });
    var sets = C.options(result, 'length');
    if (!Array.isArray(raw.profiles) || raw.profiles.length !== sets.length) C.fail('Every length option needs its own measurement chart.');
    sets.forEach(function (set) {
      var candidates = raw.profiles.filter(function (p) { return p && p.setCode === set.id; });
      if (candidates.length !== 1 || !Array.isArray(candidates[0].sizes) || candidates[0].sizes.length !== sizeIds.length) C.fail('Every length chart needs one row for each size.');
      var profile = candidates[0];
      result.profiles.push({ setCode: set.id, recommend: profile.recommend === true, sizes: sizeIds.map(function (size) {
        var rows = profile.sizes.filter(function (r) { return r && r.size === size; });
        if (rows.length !== 1) C.fail('Each size must appear once in every chart.');
        var row = rows[0], out = { size: size };
        ['shoulderIn', 'bustIn', 'sleeveIn', 'lengthIn'].forEach(function (k) { out[k] = C.number(row[k], set.label + ' / ' + size + ' / ' + k, 0.1, 200); });
        ['heightMinCm', 'heightMaxCm', 'fitMinCm', 'fitMaxCm'].forEach(function (k) { out[k] = C.number(row[k], set.label + ' / ' + size + ' / ' + k, 50, 250); });
        out.fitMinExclusive = row.fitMinExclusive === true;
        if (out.heightMaxCm < out.heightMinCm || out.fitMaxCm < out.fitMinCm) C.fail('Height ranges must run from smallest to largest.');
        return out;
      }) });
    });
    var fit = raw.fit || {};
    if (!Array.isArray(fit.rows) || fit.rows.length !== sizeIds.length || !Array.isArray(fit.heightFloors) || fit.heightFloors.length > 30) C.fail('Each size needs a recommendation-rule row.');
    var previousWeight = 0, previousBmi = 0, missingWeight = false;
    sizeIds.forEach(function (size, index) {
      var rows = fit.rows.filter(function (r) { return r && r.size === size; });
      if (rows.length !== 1) C.fail('Each size must appear once in recommendation rules.');
      var row = rows[0], out = { size: size, weightMaxExclusive: row.weightMaxExclusive === true };
      ['maxWeightKg', 'adjustUpKg', 'adjustDownKg', 'bodyBustIn'].forEach(function (k) { out[k] = C.number(row[k], size + ' / ' + k, 1, 400, true); });
      out.maxBmi = C.number(row.maxBmi, size + ' / BMI', 1, 100, true);
      if (out.maxWeightKg === null) missingWeight = true;
      else {
        if (missingWeight || out.maxWeightKg <= previousWeight) C.fail('Weight limits must increase in size order; unfinished rules go at the end.');
        previousWeight = out.maxWeightKg;
      }
      if (out.maxBmi !== null) { if (out.maxBmi <= previousBmi) C.fail('BMI limits must increase in size order.'); previousBmi = out.maxBmi; }
      result.fit.rows.push(out);
    });
    result.fit.heightFloors = fit.heightFloors.map(function (f) {
      if (!f || sizeIds.indexOf(f.size) < 0) C.fail('Height rules must refer to an existing size.');
      return { size: f.size, fromCm: C.number(f.fromCm, 'Height threshold', 50, 250), exclusive: f.exclusive === true };
    });
    // Overlapping fit ranges would make the choice dependent on display order.
    sizeIds.forEach(function (size) {
      var ranges = result.profiles.filter(function (p) { return p.recommend; }).map(function (p) { return p.sizes.filter(function (r) { return r.size === size; })[0]; }).sort(function (a, b) { return a.fitMinCm - b.fitMinCm; });
      ranges.forEach(function (r, i) { if (i && (r.fitMinCm < ranges[i - 1].fitMaxCm || (r.fitMinCm === ranges[i - 1].fitMaxCm && !r.fitMinExclusive))) C.fail('Calculator height ranges overlap for size ' + size + '. Adjust the ranges or disable recommendations for the new set.'); });
    });
    if (JSON.stringify(result).length > 42000) C.fail('This product has too many chart rows.');
    return result;
  };
  C.read = function (store, product) {
    var saved = store.list('SYSTEM_META').filter(function (r) { return r.meta_key === C.key(product.product_id); })[0];
    if (saved) {
      var value = JSON.parse(saved.meta_value), normalized = C.normalize(value, product.product_code);
      normalized.revision = Number(value.revision) || 0; normalized.updatedAt = saved.updated_at;
      normalized.lastRequestId = value.lastRequestId || '';
      return normalized;
    }
    var profiles = store.list('SIZE_PROFILES').filter(function (p) { return !p.product_id || p.product_id === product.product_id; }).map(function (p) {
      return { setCode: p.set_code, label: p.name, sizes: store.list('SIZE_PROFILE_ROWS').filter(function (r) { return r.profile_id === p.profile_id; }).map(function (r) {
        return { size: r.size, shoulderIn: Number(r.shoulder_in), bustIn: Number(r.bust_in), sleeveIn: Number(r.sleeve_in), lengthIn: Number(r.length_in), heightMinCm: Number(r.height_min_cm), heightMaxCm: Number(r.height_max_cm) };
      }) };
    });
    return C.defaults(product.product_code, profiles);
  };
  C.recommend = function (config, heightValue, weightValue) {
    var height = Number(String(heightValue).trim()), weight = Number(String(weightValue).trim());
    if (!Number.isFinite(height) || !Number.isFinite(weight) || height <= 0 || weight <= 0) return { ok: false, reason: 'invalid' };
    if (!config || !config.fit.enabled) return { ok: false, reason: 'unconfigured' };
    var profiles = config.profiles.filter(function (p) { return p.recommend; });
    if (!profiles.length) return { ok: false, reason: 'unconfigured' };
    var ranges = []; profiles.forEach(function (p) { ranges = ranges.concat(p.sizes); });
    if (height < Math.min.apply(null, ranges.map(function (r) { return r.fitMinCm; }))) return { ok: false, reason: 'height-low' };
    if (height > Math.max.apply(null, ranges.map(function (r) { return r.fitMaxCm; }))) return { ok: false, reason: 'height-high' };
    var rows = config.fit.rows.filter(function (r) { return r.maxWeightKg !== null; });
    var index = rows.findIndex(function (r) { return r.weightMaxExclusive ? weight < r.maxWeightKg : weight <= r.maxWeightKg; });
    if (index < 0) return { ok: false, reason: 'weight-high' };
    var bmi = weight / Math.pow(height / 100, 2);
    var bmiIndex = rows.findIndex(function (r) { return r.maxBmi !== null && bmi <= r.maxBmi; });
    if (bmiIndex < 0) bmiIndex = rows.length - 1;
    var rule = rows[index];
    if (bmiIndex > index && rule.adjustUpKg !== null && weight >= rule.adjustUpKg) index++;
    else if (bmiIndex < index && rule.adjustDownKg !== null && weight <= rule.adjustDownKg) index--;
    config.fit.heightFloors.forEach(function (floor) {
      if (floor.exclusive ? height > floor.fromCm : height >= floor.fromCm) index = Math.max(index, rows.findIndex(function (r) { return r.size === floor.size; }));
    });
    rule = rows[index];
    if (!rule) return { ok: false, reason: 'unconfigured' };
    var matching = profiles.filter(function (p) {
      return p.sizes.some(function (r) { return r.size === rule.size && (r.fitMinExclusive ? height > r.fitMinCm : height >= r.fitMinCm) && height <= r.fitMaxCm; });
    });
    if (matching.length !== 1) return { ok: false, reason: 'unconfigured' };
    return { ok: true, set: matching[0].setCode, setLabel: C.label(config, 'length', matching[0].setCode), size: rule.size, sizeLabel: C.label(config, 'size', rule.size), bustIn: rule.bodyBustIn };
  };
  C.combinations = function (config) {
    var output = [], colours = C.options(config, 'colour');
    C.options(config, 'length').forEach(function (length) { C.options(config, 'size').forEach(function (size) { (colours.length ? colours : [{ id: '', label: '' }]).forEach(function (colour) {
      output.push({ lengthSet: length.id, size: size.id, colour: colour.id, sellerSku: [config.productCode, colour.id, length.id, size.id].filter(Boolean).join('-') });
    }); }); });
    if (output.length > 300) C.fail('Limit this product to 300 length, size and colour combinations.');
    var skus = Object.create(null);
    output.forEach(function (v) {
      if (v.sellerSku.length > 40 || skus[v.sellerSku]) C.fail('Option codes produce duplicate or overly long SKUs. Keep the combined SKU within 40 characters.');
      skus[v.sellerSku] = true;
    });
    return output;
  };
  root.ArabistaProductConfig = C;
  if (typeof AO !== 'undefined') AO.productConfig = C;
})(typeof globalThis !== 'undefined' ? globalThis : this);
