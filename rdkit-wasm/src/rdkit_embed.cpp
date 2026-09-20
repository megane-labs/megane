// RDKit 3D embedding for the browser.
//
// A deliberately small Emscripten/embind surface over RDKit: parse a molecule
// (SMILES or MDL mol block), add hydrogens, generate one or more ETKDG
// conformers, relax them with MMFF94(s) or UFF, and hand the result back as
// mol blocks. Everything crosses the JS boundary as strings (input, a JSON
// options object, a JSON result) so no embind class lifetimes leak into the
// caller. megane's Builder feeds the mol blocks straight into its existing
// MOL parser, so the host side never learns RDKit's object model.
//
// The official RDKit MinimalLib (RDKit.js) exposes only 2D coordinate
// generation; this wrapper exists to make ETKDG available without Python.

#include <emscripten/bind.h>

#include <boost/property_tree/json_parser.hpp>
#include <boost/property_tree/ptree.hpp>

#include <GraphMol/Conformer.h>
#include <GraphMol/DistGeomHelpers/Embedder.h>
#include <GraphMol/FileParsers/FileParsers.h>
#include <GraphMol/FileParsers/FileWriters.h>
#include <GraphMol/ForceFieldHelpers/MMFF/MMFF.h>
#include <GraphMol/ForceFieldHelpers/UFF/UFF.h>
#include <GraphMol/MolOps.h>
#include <GraphMol/RWMol.h>
#include <GraphMol/SmilesParse/SmilesParse.h>
#include <RDGeneral/RDLog.h>
#include <RDGeneral/versions.h>

#include <cmath>
#include <cstdio>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace pt = boost::property_tree;

namespace {

// ---------------------------------------------------------------------------
// JSON output helpers (the result is small and flat; no library needed).

std::string jsonEscape(const std::string &s) {
  std::string out;
  out.reserve(s.size() + 8);
  for (unsigned char c : s) {
    switch (c) {
      case '"':
        out += "\\\"";
        break;
      case '\\':
        out += "\\\\";
        break;
      case '\n':
        out += "\\n";
        break;
      case '\r':
        out += "\\r";
        break;
      case '\t':
        out += "\\t";
        break;
      default:
        if (c < 0x20) {
          char buf[8];
          snprintf(buf, sizeof(buf), "\\u%04x", c);
          out += buf;
        } else {
          out += static_cast<char>(c);
        }
    }
  }
  return out;
}

std::string jsonString(const std::string &s) { return "\"" + jsonEscape(s) + "\""; }

std::string jsonNumberOrNull(double v) {
  if (!std::isfinite(v)) {
    return "null";
  }
  std::ostringstream ss;
  ss.precision(10);
  ss << v;
  return ss.str();
}

std::string errorJson(const std::string &message) {
  return "{\"error\":" + jsonString(message) + "}";
}

// ---------------------------------------------------------------------------
// Options

struct Options {
  // "auto" sniffs a mol block by its counts line; otherwise "smiles" / "molblock".
  std::string format = "auto";
  bool sanitize = true;
  // Add the hydrogens the valences call for before embedding (ETKDG needs them).
  bool addHs = true;
  // Strip hydrogens from the returned mol blocks.
  bool removeHs = false;
  unsigned int numConfs = 1;
  // "MMFF94s" | "MMFF94" | "UFF" | "none"
  std::string forceField = "MMFF94s";
  int maxIters = 500;
  // -1 lets RDKit pick a random seed; callers wanting reproducibility set one.
  int randomSeed = -1;
  // Retry with random initial coordinates when the default embedding fails
  // (RDKit's own advice for large or strained molecules).
  bool retryWithRandomCoords = true;
  // Raw JSON handed to RDKit's updateEmbedParametersFromJSON (useRandomCoords,
  // maxIterations, pruneRmsThresh, enforceChirality, ...).
  std::string embedParamsJson;
};

Options parseOptions(const std::string &json) {
  Options o;
  if (json.empty()) {
    return o;
  }
  pt::ptree tree;
  std::istringstream ss(json);
  pt::read_json(ss, tree);
  o.format = tree.get<std::string>("format", o.format);
  o.sanitize = tree.get<bool>("sanitize", o.sanitize);
  o.addHs = tree.get<bool>("addHs", o.addHs);
  o.removeHs = tree.get<bool>("removeHs", o.removeHs);
  o.numConfs = tree.get<unsigned int>("numConfs", o.numConfs);
  o.forceField = tree.get<std::string>("forceField", o.forceField);
  o.maxIters = tree.get<int>("maxIters", o.maxIters);
  o.randomSeed = tree.get<int>("randomSeed", o.randomSeed);
  o.retryWithRandomCoords =
      tree.get<bool>("retryWithRandomCoords", o.retryWithRandomCoords);
  if (auto child = tree.get_child_optional("embedParams")) {
    std::ostringstream out;
    pt::write_json(out, *child, false);
    o.embedParamsJson = out.str();
  }
  if (o.numConfs == 0) {
    throw std::invalid_argument("numConfs must be at least 1.");
  }
  if (o.forceField != "MMFF94s" && o.forceField != "MMFF94" &&
      o.forceField != "UFF" && o.forceField != "none") {
    throw std::invalid_argument("forceField must be MMFF94s, MMFF94, UFF or none.");
  }
  return o;
}

// ---------------------------------------------------------------------------
// Input

bool looksLikeMolBlock(const std::string &s) {
  if (s.find('\n') == std::string::npos) {
    return false;
  }
  return s.find("V2000") != std::string::npos ||
         s.find("V3000") != std::string::npos ||
         s.find("M  END") != std::string::npos;
}

std::unique_ptr<RDKit::RWMol> parseInput(const std::string &input,
                                         const Options &o) {
  std::string format = o.format;
  if (format == "auto") {
    format = looksLikeMolBlock(input) ? "molblock" : "smiles";
  }
  if (format == "molblock") {
    RDKit::v2::FileParsers::MolFileParserParams ps;
    ps.sanitize = o.sanitize;
    // Keep the hydrogens the file spells out; addHs() completes the rest.
    ps.removeHs = false;
    ps.strictParsing = false;
    auto mol = RDKit::v2::FileParsers::MolFromMolBlock(input, ps);
    if (!mol) {
      throw std::runtime_error("Could not parse the mol block.");
    }
    return mol;
  }
  if (format == "smiles") {
    RDKit::SmilesParserParams ps;
    ps.sanitize = o.sanitize;
    ps.removeHs = false;
    std::unique_ptr<RDKit::RWMol> mol(RDKit::SmilesToMol(input, ps));
    if (!mol) {
      throw std::runtime_error("Could not parse the SMILES.");
    }
    return mol;
  }
  throw std::invalid_argument("format must be auto, smiles or molblock.");
}

// ---------------------------------------------------------------------------
// Embedding

RDKit::INT_VECT embedConformers(RDKit::RWMol &mol, const Options &o,
                                std::vector<std::string> &warnings) {
  // The small-ring-aware ETKDG v3 parameter set (what RDKit's own C FFI uses).
  RDKit::DGeomHelpers::EmbedParameters params = RDKit::DGeomHelpers::srETKDGv3;
  params.randomSeed = o.randomSeed;
  params.clearConfs = true;
  if (!o.embedParamsJson.empty()) {
    RDKit::DGeomHelpers::updateEmbedParametersFromJSON(params, o.embedParamsJson);
  }
  RDKit::INT_VECT confIds =
      RDKit::DGeomHelpers::EmbedMultipleConfs(mol, o.numConfs, params);
  if (confIds.empty() && o.retryWithRandomCoords && !params.useRandomCoords) {
    warnings.push_back(
        "Embedding with default parameters failed; retried with random initial coordinates.");
    params.useRandomCoords = true;
    confIds = RDKit::DGeomHelpers::EmbedMultipleConfs(mol, o.numConfs, params);
  }
  // updateEmbedParametersFromJSON allocates the coordinate map when the
  // caller passes one; the parameter struct does not own it.
  if (params.coordMap) {
    delete params.coordMap;
    params.coordMap = nullptr;
  }
  return confIds;
}

// Returns the force field that was actually applied ("none" when skipped).
std::string optimizeConformers(RDKit::RWMol &mol, const Options &o,
                               std::vector<std::pair<int, double>> &results,
                               std::vector<std::string> &warnings) {
  std::string ff = o.forceField;
  if (ff == "none") {
    return ff;
  }
  if (ff == "MMFF94" || ff == "MMFF94s") {
    RDKit::MMFF::MMFFMolProperties props(mol, ff);
    if (props.isValid()) {
      RDKit::MMFF::MMFFOptimizeMoleculeConfs(mol, results, 1, o.maxIters, ff);
      return ff;
    }
    warnings.push_back(ff + " has no parameters for this molecule; used UFF instead.");
    ff = "UFF";
  }
  RDKit::UFF::UFFOptimizeMoleculeConfs(mol, results, 1, o.maxIters);
  return ff;
}

// ---------------------------------------------------------------------------
// Entry points

std::string version() { return RDKit::rdkitVersion; }

void setVerbose(bool verbose) {
  if (verbose) {
    boost::logging::enable_logs("rdApp.*");
  } else {
    boost::logging::disable_logs("rdApp.*");
  }
}

std::string embed(const std::string &input, const std::string &optionsJson) {
  try {
    const Options o = parseOptions(optionsJson);
    std::vector<std::string> warnings;

    std::unique_ptr<RDKit::RWMol> mol = parseInput(input, o);
    if (mol->getNumAtoms() == 0) {
      return errorJson("The molecule has no atoms.");
    }
    if (o.addHs) {
      RDKit::MolOps::addHs(*mol);
    }

    const RDKit::INT_VECT confIds = embedConformers(*mol, o, warnings);
    if (confIds.empty()) {
      return errorJson(
          "ETKDG could not embed the molecule. Check its valences and stereo "
          "assignments, or pass embedParams.useRandomCoords: true.");
    }

    std::vector<std::pair<int, double>> ffResults;
    const std::string applied = optimizeConformers(*mol, o, ffResults, warnings);

    if (o.removeHs) {
      RDKit::MolOps::removeHs(*mol);
    }

    std::ostringstream out;
    out << "{\"molblocks\":[";
    for (size_t i = 0; i < confIds.size(); ++i) {
      if (i) {
        out << ',';
      }
      out << jsonString(RDKit::MolToMolBlock(*mol, true, confIds[i], true, false));
    }
    out << "],\"energies\":[";
    for (size_t i = 0; i < confIds.size(); ++i) {
      if (i) {
        out << ',';
      }
      const bool have = i < ffResults.size() && ffResults[i].first >= 0;
      out << (have ? jsonNumberOrNull(ffResults[i].second) : "null");
    }
    out << "],\"converged\":[";
    for (size_t i = 0; i < confIds.size(); ++i) {
      if (i) {
        out << ',';
      }
      const bool converged = i < ffResults.size() && ffResults[i].first == 0;
      out << (converged ? "true" : "false");
    }
    out << "],\"forceField\":" << jsonString(applied);
    out << ",\"numAtoms\":" << mol->getNumAtoms();
    out << ",\"numHeavyAtoms\":" << mol->getNumHeavyAtoms();
    out << ",\"warnings\":[";
    for (size_t i = 0; i < warnings.size(); ++i) {
      if (i) {
        out << ',';
      }
      out << jsonString(warnings[i]);
    }
    out << "]}";
    return out.str();
  } catch (const std::exception &e) {
    return errorJson(e.what());
  } catch (...) {
    return errorJson("Unknown error during embedding.");
  }
}

struct LogInit {
  LogInit() {
    RDLog::InitLogs();
    // RDKit chatter goes to console.error in the browser; opt in via setVerbose.
    boost::logging::disable_logs("rdApp.*");
  }
} logInit;

}  // namespace

EMSCRIPTEN_BINDINGS(rdkit_embed) {
  emscripten::function("version", &version);
  emscripten::function("setVerbose", &setVerbose);
  emscripten::function("embed", &embed);
}
