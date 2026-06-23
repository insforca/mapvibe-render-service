-- scripts/pmtiles-prototype/tilemaker-process.lua
--
-- Per-feature attribute mapping for Tilemaker. The OSM tags that
-- python/mapvibe_render.py reads are preserved verbatim as MVT attributes —
-- no value collapsing, no tier remapping. The tier logic
-- (_CLEAN_HIDDEN_TYPES, get_edge_colors) stays in Python at draw time so
-- Clean / Detailed mode toggling works exactly as today.
--
-- Reference: https://github.com/systemed/tilemaker/blob/master/docs/CONFIGURATION.md

-- ── Tag value sets — must match python/mapvibe_render.py exactly ───────────────

local STREET_HIGHWAY_VALUES = {
  motorway       = true, motorway_link   = true,
  trunk          = true, trunk_link      = true,
  primary        = true, primary_link    = true,
  secondary      = true, secondary_link  = true,
  tertiary       = true, tertiary_link   = true,
  residential    = true, living_street   = true, unclassified = true,
  service        = true, track           = true, path         = true,
  footway        = true, cycleway        = true, pedestrian   = true,
  steps          = true,
}

local WATER_NATURAL_VALUES = {
  water = true, bay = true, strait = true,
}

local PARK_LEISURE_VALUES  = { park = true }
local PARK_LANDUSE_VALUES  = { grass = true }

local RAIL_RAILWAY_VALUES = {
  rail = true, light_rail = true, subway = true,
  tram = true, monorail   = true,
}

-- ── node_function ─────────────────────────────────────────────────────────────
-- We render no point features; ignore every node.
function node_function()
end

-- ── way_function ──────────────────────────────────────────────────────────────
function way_function()
  local highway = Find("highway")
  local railway = Find("railway")
  local natural = Find("natural")
  local waterway = Find("waterway")
  local leisure = Find("leisure")
  local landuse = Find("landuse")

  -- STREETS (LineString)
  if STREET_HIGHWAY_VALUES[highway] then
    Layer("streets", false)              -- false = is_area; ways are lines
    Attribute("highway", highway)
    -- Surface / tunnel / bridge could matter for future styles. Cheap to keep.
    local tunnel = Find("tunnel")
    if tunnel ~= "" then Attribute("tunnel", tunnel) end
    local bridge = Find("bridge")
    if bridge ~= "" then Attribute("bridge", bridge) end
    return
  end

  -- RAIL (LineString)
  if RAIL_RAILWAY_VALUES[railway] then
    Layer("rail", false)
    Attribute("railway", railway)
    return
  end

  -- WATER as polygon (natural=water | bay | strait — closed ways)
  if WATER_NATURAL_VALUES[natural] then
    Layer("water", true)
    Attribute("natural", natural)
    return
  end

  -- WATER as polygon (waterway=riverbank — closed ways)
  if waterway == "riverbank" then
    Layer("water", true)
    Attribute("waterway", waterway)
    return
  end

  -- PARKS (leisure=park or landuse=grass — closed ways)
  if PARK_LEISURE_VALUES[leisure] then
    Layer("parks", true)
    Attribute("leisure", leisure)
    return
  end
  if PARK_LANDUSE_VALUES[landuse] then
    Layer("parks", true)
    Attribute("landuse", landuse)
    return
  end
end

-- ── relation_scan_function ─────────────────��──────────────────────────────────
-- Tag-driven dispatch so multipolygon water / parks become Layer features.
function relation_scan_function()
  local type_ = Find("type")
  if type_ ~= "multipolygon" then return end

  local natural = Find("natural")
  local waterway = Find("waterway")
  local leisure = Find("leisure")
  local landuse = Find("landuse")

  if WATER_NATURAL_VALUES[natural]
     or waterway == "riverbank"
     or PARK_LEISURE_VALUES[leisure]
     or PARK_LANDUSE_VALUES[landuse] then
    Accept()
  end
end

-- ── relation_function ─────────────────────────────────────────────────────────
function relation_function()
  local natural = Find("natural")
  local waterway = Find("waterway")
  local leisure = Find("leisure")
  local landuse = Find("landuse")

  if WATER_NATURAL_VALUES[natural] then
    Layer("water", true)
    Attribute("natural", natural)
  elseif waterway == "riverbank" then
    Layer("water", true)
    Attribute("waterway", waterway)
  elseif PARK_LEISURE_VALUES[leisure] then
    Layer("parks", true)
    Attribute("leisure", leisure)
  elseif PARK_LANDUSE_VALUES[landuse] then
    Layer("parks", true)
    Attribute("landuse", landuse)
  end
end