/**
 * Human labels for feature fields.
 *
 * Looked up as `type.key` first, then `key`: `dx` is a box's length but a linear
 * pattern's direction, and reading "length" over a direction component is worse than
 * reading the raw key.
 */
export const FIELD_LABELS: Record<string, string> = {
  dx: 'length', dy: 'width', dz: 'height',
  radius: 'radius', height: 'height', distance: 'distance',
  x: 'x', y: 'y', z: 'z',

  'hole.standard': 'fastener', 'hole.fit': 'fit', 'hole.style': 'style',
  'hole.x': 'centre x', 'hole.y': 'centre y', 'hole.z': 'top of hole',
  'hole.diameter': 'diameter (overrides fastener)',
  'hole.compensation': 'FDM compensation',
  'hole.counterboreDepth': 'counterbore depth',

  'shell.thickness': 'wall thickness',

  'text.text': 'label', 'text.font': 'font', 'text.size': 'cap height',
  'text.depth': 'depth (negative engraves)', 'text.angle': 'angle on the face',

  'draft.angle': 'taper \u00b0', 'draft.neutralZ': 'pivot height',
  'draft.pullX': 'pull x', 'draft.pullY': 'pull y', 'draft.pullZ': 'pull z',

  'loft.ruled': 'straight sides (1/0)',

  'revolve.angle': 'angle °',
  'revolve.axisX': 'axis x', 'revolve.axisY': 'axis y', 'revolve.axisZ': 'axis z',

  'mirror.normalX': 'plane normal x', 'mirror.normalY': 'plane normal y',
  'mirror.normalZ': 'plane normal z', 'mirror.keepOriginal': 'keep original (1/0)',
  'mirror.x': 'plane through x', 'mirror.y': 'plane through y', 'mirror.z': 'plane through z',

  'linearPattern.count': 'copies', 'linearPattern.spacing': 'spacing',
  'linearPattern.dx': 'direction x', 'linearPattern.dy': 'direction y',
  'linearPattern.dz': 'direction z',

  'circularPattern.count': 'copies', 'circularPattern.angle': 'sweep °',
  'circularPattern.x': 'centre x', 'circularPattern.y': 'centre y',
  'circularPattern.z': 'centre z',
  'circularPattern.axisX': 'axis x', 'circularPattern.axisY': 'axis y',
  'circularPattern.axisZ': 'axis z',
};

/** Fields that are not lengths, by `type.key` then `key`. Everything else is mm. */
export const FIELD_UNITS: Record<string, string> = {
  angle: '\u00b0', count: '', keepOriginal: '',
  axisX: '', axisY: '', axisZ: '',
  normalX: '', normalY: '', normalZ: '',
  // A box's dx is a length; a pattern's dx is a direction component.
  'linearPattern.dx': '', 'linearPattern.dy': '', 'linearPattern.dz': '',
  'draft.pullX': '', 'draft.pullY': '', 'draft.pullZ': '',
  ruled: '', symmetric: '',
};

/** What each tool wants, as its button's tooltip. */
export const TOOL_HINTS: Record<string, string> = {
  line: 'Connected lines: click each point; click the first again to close',
  rectangle: 'Click two opposite corners',
  circle: 'Click the centre, then the rim',
  arc: 'Click both ends: a half circle to start; type into its sweep or radius to change it',
  dimension: 'Click two points for a length, or a circle for its radius',
  trim: 'Click a piece of a curve to take it away; what is left keeps its dimensions',
  select: 'Click geometry to select; shift-click to add',
  constrain: 'Click geometry to gather a selection, then right-click for constraints and dimensions',
};

/** Human names for constraint types, for the sketch's constraint list. */
export const CONSTRAINT_LABELS: Record<string, string> = {
  coincident: 'coincident', horizontal: 'horizontal', vertical: 'vertical', parallel: 'parallel',
  perpendicular: 'perpendicular', tangent: 'tangent', equal: 'equal', concentric: 'concentric',
  pointOnLine: 'point on line', symmetric: 'symmetric', distance: 'distance',
  pointLineDistance: 'point to line', lineLineDistance: 'line to line',
  circleLineDistance: 'circle to line', pointCircleDistance: 'point to circle',
  radius: 'radius', diameter: 'diameter', angle: 'angle', sweep: 'arc sweep',
  pointOnCircle: 'point on circle', lockX: 'lock x', lockY: 'lock y',
};
