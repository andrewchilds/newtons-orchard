# Real-body surface maps

Equirectangular global maps for `Body.texture` (see `REAL_TEXTURE_KEYS` in
`src/lib/types.ts`). All are public domain (US government works). Each was
downsized to 2048×1024 (JPEG q88) unless noted; processing beyond resizing is
listed per file.

| File | Source | Processing |
| --- | --- | --- |
| `mercury.jpg` | NASA/JHUAPL/Carnegie, MESSENGER MDIS enhanced-color basemap ([PIA17386](https://images.nasa.gov/details/PIA17386)) | converted to grayscale luminance (the enhanced color is false-color mineralogy), faint warm tint |
| `venus.jpg` | NASA/USGS, Magellan C3-MDIR colorized radar mosaic ([Astropedia](https://astrogeology.usgs.gov/search/map/venus_magellan_c3_mdir_colorized_global_mosaic_4641m)) | resize only — radar surface, not the visible cloud deck |
| `earth.jpg` | NASA/GSFC, Blue Marble Next Generation w/ topography and bathymetry, Dec 2004 ([Visible Earth 73909](https://visibleearth.nasa.gov/images/73909)) | resize only |
| `moon.jpg` | NASA/GSFC/ASU, LROC WAC color mosaic ([SVS CGI Moon Kit](https://svs.gsfc.nasa.gov/4720/), `lroc_color_poles_4k.tif`) | resize only |
| `mars.jpg` | NASA/USGS, Viking MDIM 2.1 colorized mosaic (via [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Mars_Viking_MDIM21_ClrMosaic_1km.jpg), PD USGS product) | glitched rows at the extreme poles clamped |
| `ceres.jpg` | NASA/JPL-Caltech/UCLA/MPS/DLR/IDA, Dawn FC2 HAMO clear-filter global mosaic, equidistant cylindrical ([PDS SBN, DWNCHCFC2_2](https://sbnarchive.psi.edu/pds3/dawn/fc/DWNCHCFC2_2/EXTRAS/CE_HAMO_G_00N_180E_EQU_CLR.TIF)) | grayscale source, faint warm tint; polar bands keep the mosaic's baked-in low-sun shadows |
| `jupiter.jpg` | NASA/JPL/SSI, Cassini cylindrical map ([PIA07782](https://images.nasa.gov/details/PIA07782)) | resize only |
| `saturn.jpg` | NASA/JPL/SSI, Cassini ISS RGB global map, Aug 2011 ([PDS Atmospheres](https://atmos.nmsu.edu/data_and_services/atmospheres_data/Cassini/sat_global_map_11062023.html), FITS) | FITS→JPEG; missing latitudes (poles, ring-shadow band) filled by zonal interpolation; saturation/contrast lift |
| `uranus.jpg` | generated (1024×512) | no public-domain Voyager map exists; Uranus was a near-featureless pale-cyan disk, encoded here as a smooth gradient with a south-polar haze cap |
| `neptune.jpg` | NASA/JPL (Don Davis), from [NASA 3D resources](https://science.nasa.gov/3d-resources/neptune/) — labeled "fictional" cloud texture; no observational map exists | 720×360 native; corrupt bottom rows repaired, graded toward Voyager's azure |
