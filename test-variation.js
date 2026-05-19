import opentype from 'opentype.js';

opentype.load('AnekLatin-VariableFont_wdth,wght.ttf').then(font => {
  const glyph = font.glyphs.get(40); // e.g., 'a' or something
  
  // Default path
  const defaultPath = glyph.getPath(0, 0, 1000);
  console.log("Default path cmds length:", defaultPath.commands.length);
  console.log("Default first few:", defaultPath.commands.slice(0,3));

  // Variation path
  const varFont = font.getVariation({ wght: 800, wdth: 120 });
  const varGlyph = varFont.glyphs.get(40);
  const varPath = varGlyph.getPath(0, 0, 1000);
  console.log("Variation path cmds length:", varPath.commands.length);
  console.log("Variation first few:", varPath.commands.slice(0,3));
});
