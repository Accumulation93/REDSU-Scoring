'use strict';

function text(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function uniqueBy(items, keyOf) {
  const seen = new Set();
  return (items || []).filter(function(item) {
    const key = keyOf(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function assignmentFields(person, assignment) {
  const source = assignment || {};
  const snapshot = source.assignment || {};
  return {
    personId: text(person.personId || person.person_id || source.personId || source.person_id),
    id: text(person.id || person.hrId || source.hrId || source.legacyHrId),
    hrId: text(person.hrId || person.id || source.hrId || source.legacyHrId),
    name: text(person.name || person.personName || source.name || source.personName),
    assignmentId: text(source.assignmentId || source.assignment_id || source.id),
    assignmentLabel: text(source.assignmentLabel || source.assignment_label || source._eligibleAssignmentText || source._selectionText || snapshot.assignmentLabel),
    departmentId: text(source.departmentId || source.department_id || snapshot.departmentId),
    departmentName: text(source.departmentName || source.department_name || source.department || snapshot.departmentName),
    identityCategoryId: text(source.identityCategoryId || source.identity_category_id || snapshot.identityCategoryId),
    identityCategoryName: text(source.identityCategoryName || source.identity_category_name || source.identity || snapshot.identityCategoryName),
    workGroupId: text(source.workGroupId || source.work_group_id || snapshot.workGroupId),
    workGroupName: text(source.workGroupName || source.work_group_name || source.workGroup || snapshot.workGroupName),
    isCurrent: Boolean(source.isCurrent)
  };
}

function flattenAssignmentOptions(options) {
  const flattened = [];
  for (const person of (Array.isArray(options) ? options : [])) {
    const nestedAssignments = Array.isArray(person.eligibleAssignments) && person.eligibleAssignments.length
      ? person.eligibleAssignments
      : person.assignments;
    const assignments = Array.isArray(nestedAssignments) && nestedAssignments.length
      ? nestedAssignments
      : [person];
    for (const assignment of assignments) {
      const option = assignmentFields(person, assignment);
      if (!option.assignmentId) continue;
      option.selectionKey = option.assignmentId;
      flattened.push(option);
    }
  }
  return uniqueBy(flattened, function(item) { return item.selectionKey; });
}

function normalizePersonOptions(options) {
  const normalized = [];
  for (const person of (Array.isArray(options) ? options : [])) {
    const rawAssignments = person.assignments || person.eligibleAssignments || [];
    const assignments = (Array.isArray(rawAssignments) ? rawAssignments : []).map(function(assignment) {
      return assignmentFields(person, assignment);
    }).filter(function(assignment) { return assignment.assignmentId; });
    const personId = text(person.personId || person.person_id || person.id || person.hrId);
    if (!personId) continue;
    const first = assignments[0] || assignmentFields(person, person);
    normalized.push({
      selectionKey: personId,
      personId,
      id: text(person.id || person.hrId),
      hrId: text(person.hrId || person.id),
      name: text(person.name || person.personName),
      assignmentId: '',
      assignmentLabel: '',
      departmentId: '',
      departmentName: '',
      identityCategoryId: '',
      identityCategoryName: '',
      workGroupId: '',
      workGroupName: '',
      assignments: assignments.length ? assignments : (first.assignmentId ? [first] : [])
    });
  }
  return uniqueBy(normalized, function(item) { return item.selectionKey; });
}

function normalizeOptions(options, selectionLevel) {
  return selectionLevel === 'person'
    ? normalizePersonOptions(options)
    : flattenAssignmentOptions(options);
}

function tupleList(item) {
  return Array.isArray(item.assignments) && item.assignments.length ? item.assignments : [item];
}

function tupleMatches(tuple, filters) {
  return (!filters.department || tuple.departmentName === filters.department)
    && (!filters.identity || tuple.identityCategoryName === filters.identity)
    && (!filters.workGroup || tuple.workGroupName === filters.workGroup);
}

function filterOptions(options, filters) {
  const query = text(filters && filters.keyword).toLowerCase();
  return (options || []).filter(function(item) {
    const tuples = tupleList(item);
    if (!tuples.some(function(tuple) { return tupleMatches(tuple, filters || {}); })) return false;
    if (!query) return true;
    const haystack = [item.name].concat(tuples.reduce(function(parts, tuple) {
      return parts.concat([
        tuple.assignmentLabel,
        tuple.departmentName,
        tuple.identityCategoryName,
        tuple.workGroupName
      ]);
    }, [])).join(' ').toLowerCase();
    return haystack.indexOf(query) >= 0;
  });
}

function optionNames(options, field) {
  const names = [];
  for (const item of (options || [])) {
    for (const tuple of tupleList(item)) {
      const value = text(tuple[field]);
      if (value) names.push(value);
    }
  }
  return uniqueBy(names, function(value) { return value; });
}

function selectedKeys(value, selectionLevel) {
  return uniqueBy((Array.isArray(value) ? value : []).map(function(item) {
    if (typeof item === 'string') return text(item);
    return selectionLevel === 'person'
      ? text(item.selectionKey || item.personId || item.id || item.hrId)
      : text(item.selectionKey || item.assignmentId || item.assignment_id || item.id);
  }), function(key) { return key; });
}

function toggleSelection(keys, key, multiple) {
  const next = selectedKeys(keys, 'assignment');
  const target = text(key);
  if (!target) return next;
  const index = next.indexOf(target);
  if (index >= 0) next.splice(index, 1);
  else if (multiple) next.push(target);
  else next.splice(0, next.length, target);
  return next;
}

function selectionSummary(items, countText) {
  const list = Array.isArray(items) ? items : [];
  const details = list.map(function(item) {
    const assignment = text(item.assignmentLabel || item._eligibleAssignmentText || item._assignmentText);
    return [text(item.name), assignment].filter(Boolean).join(' · ');
  }).filter(Boolean);
  return [text(countText), details.join('；')].filter(Boolean).join(' · ');
}

module.exports = {
  filterOptions,
  normalizeOptions,
  optionNames,
  selectedKeys,
  toggleSelection,
  selectionSummary
};
