# Computational Design Letterpress Fabricator

**Live Tool:** [http://typedesign.fba.up.pt/letterpress-fabricator/](http://typedesign.fba.up.pt/letterpress-fabricator/)

## Description
This app is meant to streamline the fabrication of custom fonts designed digitally in the Type Design course of the master in Graphic Design and Editorial Projects. 

It is designed to assist students in getting their custom variable fonts 3D printed in the school's fablab quickly, particularly aimed at those with no prior knowledge of 3D software. 

*Note:* There are still some hacks needed to make the letters print only the necessary material/size like traditional wood type. Nevertheless, this serves as a working prototype to standardize all custom fonts to the same exact typographic measurements so they can print seamlessly in the Printmaking Workshop of FBAUP using traditional letterpress presses and materials.

<img width="1781" height="876" alt="Screenshot 2026-05-18 at 21 46 27" src="https://github.com/user-attachments/assets/6e79a369-8592-46ba-894b-d9ae2f0595ef" />


## Features
- **Variable Font Parsing:** Drop any TrueType (`.ttf`) or OpenType (`.otf`) variable font to instantly read axis extremes and glyph metrics directly in your browser.
- **Parametric Sort Generation:** Automatically extrudes type at 23.56mm typographic height and builds solid physical letterpress slugs/sorts (shoulder at 20.56mm).
- **Physical Optimization:** Configured for physical structural integrity, including minimum 8mm support walls, hollow cores with 8mm escape hatches for SLA drainage, an alignment base-nick, and a 12° bevel drafting for reinforced structural necks.
- **Direct-to-Plate Layouts:** Supports virtual floating plates or predefined physical boundaries (20x20 cm & 9x12 cm) for automated wrapping layout generation.
- **Exporting:** Single or bulk export capabilities via high-fidelity ASCII STL, Wavefront OBJ, or batch ZIP archives. 

## Credits & Links
Designed by Pedro Amado, [FBAUP](https://www.up.pt/fbaup/) / [i2ADS](https://i2ads.up.pt/), within the context of the Type Design course of the [MDGPE](https://mdgpe.fba.up.pt/) master program at FBAUP, and the [Ligatures SIG](https://ligatures.fba.up.pt/) from the i2ADS. 

Coded by Gemini Pro 3.1, May 2026.

More information and code is available at the project's [Github repository](https://github.com/pedamado/fabricator).
