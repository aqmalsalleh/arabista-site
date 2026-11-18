/*
 * Arabista V2 seller-owned size-chart JSON import: pure, source-preserving parser.
 * No image OCR, provider calls, writes, SKU generation or inferred values.
 * v2.48 owner-approved Set 3: borrow S2 measurements except length=60 inches.
 */
(function(root){
  'use strict';
  function fail(m){throw new Error(m);}
  function key(s){return String(s||'').replace(/\s*\(.*/,'').trim().toUpperCase();}
  function convert(value,unit,target){
    if(value==null||value==='')return '';
    if(typeof value!=='number'||!Number.isFinite(value)||value<=0||value>500)fail('Invalid measurement value.');
    unit=String(unit||'').toLowerCase().trim();
    var factor=target==='cm'?(unit==='cm'?1:unit==='in'?2.54:null):
      (unit==='in'?1:unit==='cm'?1/2.54:null);
    if(factor===null)fail('Unrecognized measurement unit. Use in or cm.');
    return Math.round(value*factor*100)/100;
  }
  function parse(raw,groups){
    if(typeof raw!=='string'||raw.length>42000)fail('Paste a valid size-chart JSON under 42 KB.');
    var input;
    try{input=JSON.parse(raw);}catch(e){fail('Invalid JSON.');}
    if(!input||input.schema_version!==1||!Array.isArray(input.length_sets)||
       !input.length_sets.length||input.length_sets.length>3||
       !Array.isArray(input.uncertainties))fail('Expected schema_version 1, length_sets and uncertainties.');
    if(input.uncertainties.length)fail('Resolve unreadable source measurements first: '+input.uncertainties.join('; ').slice(0,220));
    var length=(groups||[]).filter(function(g){return /^length$/i.test(g.label);})[0];
    var size=(groups||[]).filter(function(g){return /^size$/i.test(g.label);})[0];
    if(!length||!size)fail('Create Size and Length variations first.');
    var sizeMap={},charts={},allowed=size.options||[];
    allowed.forEach(function(v){sizeMap[key(v)]=v;});
    input.length_sets.forEach(function(chart){
      var code=String(chart&&chart.set_code||'').toUpperCase();
      if(!/^S[123]$/.test(code)||charts[code])fail('Chart set codes must be unique S1, S2 or S3.');
      var label=(length.options||[]).filter(function(v){return new RegExp('^Set\\s*'+code.slice(1)+'\\b','i').test(v);})[0];
      if(!label)fail('No existing Length option matches '+code+'.');
      var rows=chart.rows||[],units=chart.units||{},seen={};
      if(!Array.isArray(rows)||!rows.length||rows.length>30)fail('Invalid measurement rows for '+code+'.');
      charts[code]={
        name:label,group_label:length.label,option_label:label,
        option_key:JSON.stringify([length.label,label]),
        rows:rows.map(function(r){
          var short=key(r.size_code||r.size_label);
          if(!sizeMap[short]||seen[short])fail('Invalid or duplicate size '+short+'.');
          seen[short]=true;
          var bust=convert(r.bust,units.bust,'in');
          var min=convert(r.height_min,units.height,'cm'),max=convert(r.height_max,units.height,'cm');
          if(min!==''&&max!==''&&min>max)fail('Height ranges are reversed for '+short+'.');
          return {
            size:sizeMap[short],height_cm:'',
            length_in:convert(r.length,units.length,'in'),
            bust_cm:bust===''?'':Math.round(bust*2.54*100)/100,
            shoulder_in:convert(r.shoulder,units.shoulder,'in'),
            bust_in:bust,
            sleeve_in:convert(r.sleeve,units.sleeve,'in'),
            height_min_cm:min,height_max_cm:max
          };
        })
      };
    });
    // This derivation is specifically authorized by the W06 owner, not by OCR.
    if(!charts.S3&&charts.S2&&(length.options||[]).some(function(v){return /^Set\s*3\b/i.test(v);})){
      var label=(length.options||[]).filter(function(v){return /^Set\s*3\b/i.test(v);})[0];
      charts.S3={
        name:label,group_label:length.label,option_label:label,
        option_key:JSON.stringify([length.label,label]),
        rows:charts.S2.rows.map(function(r){var v=Object.assign({},r);v.length_in=60;return v;})
      };
    }
    var result=['S1','S2','S3'].filter(function(v){return !!charts[v];}).map(function(v){return charts[v];});
    if(result.length!==(length.options||[]).length)fail('Provide one chart per Length option.');
    result.forEach(function(set){
      if(set.rows.length!==allowed.length)fail('Each length chart requires every existing Size row.');
    });
    return result;
  }
  root.ArabistaSizeChartImportV248={parse:parse};
})(typeof globalThis!=='undefined'?globalThis:this);