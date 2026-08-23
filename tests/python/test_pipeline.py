"""Tests for the Python pipeline builder."""

from pathlib import Path

import pytest

from megane.pipeline import (
    AddBonds,
    AddCoordination,
    AddLabels,
    AddPolyhedra,
    BoundaryCompletion,
    Color,
    DrawingBoundary,
    Filter,
    Isosurface,
    LoadSpectrum,
    LoadStructure,
    LoadTrajectory,
    LoadVector,
    LoadVolumetric,
    Modify,
    NodePort,
    Pipeline,
    PortNamespace,
    Replicate,
    Representation,
    SpectrumPlot,
    Symmetry,
    VectorOverlay,
    Viewport,
    Wrap,
    build_pipeline,
    view,
    view_traj,
)

FIXTURES = Path(__file__).parent.parent / "fixtures"


class TestNodeClasses:
    """Node classes store parameters correctly."""

    def test_load_structure(self):
        n = LoadStructure("test.pdb")
        assert n.path == "test.pdb"
        assert n._node_type == "load_structure"

    def test_filter(self):
        n = Filter(query="element == 'C'")
        assert n.query == "element == 'C'"
        assert n._node_type == "filter"

    def test_modify_defaults(self):
        n = Modify()
        assert n.scale == 1.0
        assert n.opacity == 1.0
        assert n._node_type == "modify"

    def test_modify_custom(self):
        n = Modify(scale=1.5, opacity=0.3)
        assert n.scale == 1.5
        assert n.opacity == 0.3

    def test_color_defaults(self):
        n = Color()
        assert n.mode == "uniform"
        assert n.uniform_color == "#ff8800"
        assert n.range is None
        assert n._node_type == "color"

    def test_color_custom(self):
        n = Color(mode="byElement", uniform_color="#112233", range=(0.0, 10.0))
        assert n.mode == "byElement"
        assert n.uniform_color == "#112233"
        assert n.range == (0.0, 10.0)

    def test_replicate_defaults(self):
        n = Replicate()
        assert n.nx == 1
        assert n.ny == 1
        assert n.nz == 1
        assert n._node_type == "replicate"

    def test_replicate_custom(self):
        n = Replicate(nx=2, ny=3, nz=4)
        assert n.nx == 2
        assert n.ny == 3
        assert n.nz == 4

    def test_symmetry_defaults(self):
        n = Symmetry()
        assert n.mode == "expand"
        assert n._node_type == "symmetry"

    def test_symmetry_custom(self):
        n = Symmetry(mode="none")
        assert n.mode == "none"

    def test_wrap_defaults(self):
        n = Wrap()
        assert n.mode == "none"
        assert n._node_type == "wrap"

    def test_wrap_custom(self):
        n = Wrap(mode="unwrap")
        assert n.mode == "unwrap"

    def test_representation_defaults(self):
        n = Representation()
        assert n.mode == "atoms"
        assert n._node_type == "representation"

    def test_representation_custom(self):
        n = Representation(mode="cartoon")
        assert n.mode == "cartoon"

    def test_representation_line_mode(self):
        n = Representation(mode="line")
        assert n.mode == "line"

    def test_representation_licorice(self):
        n = Representation(mode="licorice")
        assert n.mode == "licorice"
        assert n._node_type == "representation"

    def test_add_bonds_default(self):
        n = AddBonds()
        assert n.source == "distance"
        assert n._node_type == "add_bond"

    def test_add_bonds_structure(self):
        n = AddBonds(source="structure")
        assert n.source == "structure"

    def test_add_bonds_top(self):
        n = AddBonds(top="topology.top")
        assert n.top == "topology.top"

    def test_add_labels(self):
        n = AddLabels(source="resname")
        assert n.source == "resname"
        assert n._node_type == "label_generator"

    def test_add_polyhedra(self):
        n = AddPolyhedra(opacity=0.7, show_edges=True)
        assert n.opacity == 0.7
        assert n.show_edges is True
        assert n._node_type == "polyhedron_generator"
        assert n.inp.coordination.handle == "coordination"
        assert n.out.mesh.handle == "mesh"

    def test_add_polyhedra_defaults(self):
        n = AddPolyhedra()
        assert n.opacity == 0.5
        assert n.show_edges is False

    def test_drawing_boundary(self):
        n = DrawingBoundary(x_min=-0.1, x_max=1.1, z_max=2.0)
        assert n.x_min == -0.1
        assert n.x_max == 1.1
        assert n.z_max == 2.0
        assert n._node_type == "drawing_boundary"

    def test_boundary_completion(self):
        n = BoundaryCompletion(mode="components")
        assert n.mode == "components"
        assert n._node_type == "boundary_completion"
        assert n.inp.particle.handle == "particle"
        assert n.inp.bond.handle == "bond"
        assert n.out.particle.handle == "particle"
        assert n.out.bond.handle == "bond"

    def test_add_coordination(self):
        n = AddCoordination(
            excluded_centers=[26],
            excluded_ligands=[8, 7],
            cutoff_tolerance=1.3,
            boundary_mode="inside",
        )
        assert n.excluded_centers == [26]
        assert n.excluded_ligands == [8, 7]
        assert n.cutoff_tolerance == 1.3
        assert n.boundary_mode == "inside"
        assert n.out.coordination.handle == "coordination"
        assert n.out.bond.handle == "bond"

    def test_load_vector(self):
        n = LoadVector("vectors.dat")
        assert n.path == "vectors.dat"
        assert n._node_type == "load_vector"

    def test_vector_overlay(self):
        n = VectorOverlay(scale=2.0)
        assert n.scale == 2.0
        assert n._node_type == "vector_overlay"

    def test_load_volumetric(self):
        n = LoadVolumetric("density.cube")
        assert n.path == "density.cube"
        assert n._node_type == "load_volumetric"

    def test_load_volumetric_defaults(self):
        n = LoadVolumetric()
        assert n.path == ""
        assert set(n._out_ports) == {"volumetric"}
        assert n._inp_ports == {}

    def test_load_spectrum(self):
        n = LoadSpectrum("ethanol.jdx")
        assert n.path == "ethanol.jdx"
        assert n._node_type == "load_spectrum"

    def test_load_spectrum_defaults(self):
        n = LoadSpectrum()
        assert n.path == ""
        assert set(n._out_ports) == {"spectrum"}
        assert n._inp_ports == {}

    def test_spectrum_plot(self):
        n = SpectrumPlot(reverse_x=False, color="#ff0000")
        assert n.reverse_x is False
        assert n.color == "#ff0000"
        assert n._node_type == "spectrum_plot"

    def test_spectrum_plot_defaults(self):
        # IR and NMR are conventionally drawn high-to-low.
        n = SpectrumPlot()
        assert n.reverse_x is True
        assert n.color == "#84cc16"
        assert set(n._inp_ports) == {"spectrum"}
        # Terminal: a spectrum has no geometry, so nothing flows onward.
        assert n._out_ports == {}

    def test_isosurface(self):
        n = Isosurface(iso_level=0.02, color="#ff0000", opacity=0.5)
        assert n.iso_level == 0.02
        assert n.color == "#ff0000"
        assert n.opacity == 0.5
        assert n._node_type == "isosurface"

    def test_isosurface_defaults(self):
        n = Isosurface()
        assert n.iso_level == 0.05
        assert n.color == "#4488ff"
        assert n.opacity == 0.7
        assert n.show_negative is False
        assert n.negative_color == "#ff4444"
        assert set(n._inp_ports) == {"volumetric"}
        assert set(n._out_ports) == {"mesh"}

    def test_load_trajectory(self):
        n = LoadTrajectory(xtc="traj.xtc")
        assert n.xtc == "traj.xtc"
        assert n._node_type == "load_trajectory"

    def test_load_trajectory_dcd(self):
        n = LoadTrajectory(dcd="run.dcd")
        assert n.dcd == "run.dcd"
        assert n.xtc is None

    def test_load_trajectory_nc(self):
        n = LoadTrajectory(nc="traj.nc")
        assert n.nc == "traj.nc"
        assert n.dcd is None

    def test_load_trajectory_lammpstrj(self):
        n = LoadTrajectory(lammpstrj="dump.lammpstrj")
        assert n.lammpstrj == "dump.lammpstrj"
        assert n.xtc is None


class TestPortObjects:
    """NodePort and PortNamespace work correctly."""

    def test_node_has_out_and_inp(self):
        n = LoadStructure("test.pdb")
        assert isinstance(n.out, PortNamespace)
        assert isinstance(n.inp, PortNamespace)

    def test_load_structure_out_ports(self):
        n = LoadStructure("test.pdb")
        p = n.out.particle
        assert isinstance(p, NodePort)
        assert p._node is n
        assert p.handle == "particle"

    def test_load_structure_out_traj(self):
        n = LoadStructure("test.pdb")
        p = n.out.traj
        assert p.handle == "trajectory"

    def test_load_structure_out_cell(self):
        n = LoadStructure("test.pdb")
        p = n.out.cell
        assert p.handle == "cell"

    def test_filter_inp_particle(self):
        n = Filter(query="element == 'C'")
        p = n.inp.particle
        assert p.handle == "in"

    def test_filter_out_particle(self):
        n = Filter(query="element == 'C'")
        p = n.out.particle
        assert p.handle == "out"

    def test_viewport_inp_traj(self):
        v = Viewport()
        p = v.inp.traj
        assert p.handle == "trajectory"

    def test_viewport_inp_bond(self):
        v = Viewport()
        p = v.inp.bond
        assert p.handle == "bond"

    def test_invalid_port_raises_attribute_error(self):
        n = LoadStructure("test.pdb")
        with pytest.raises(AttributeError, match="No port"):
            _ = n.out.nonexistent

    def test_invalid_inp_port_raises_attribute_error(self):
        n = Viewport()
        with pytest.raises(AttributeError, match="No port"):
            _ = n.inp.nonexistent

    def test_load_structure_has_no_inp_ports(self):
        n = LoadStructure("test.pdb")
        with pytest.raises(AttributeError):
            _ = n.inp.particle

    def test_viewport_has_no_out_ports(self):
        v = Viewport()
        with pytest.raises(AttributeError):
            _ = v.out.particle

    def test_port_dir_lists_available(self):
        n = LoadStructure("test.pdb")
        ports = dir(n.out)
        assert "particle" in ports
        assert "traj" in ports
        assert "cell" in ports


class TestPipelineAddNode:
    """Pipeline.add_node() assigns IDs and stores nodes."""

    def test_add_single_node(self):
        pipe = Pipeline()
        n = pipe.add_node(LoadStructure(str(FIXTURES / "1crn.pdb")))
        assert n._id is not None
        assert n._id.startswith("load_structure-")

    def test_add_multiple_nodes_unique_ids(self):
        pipe = Pipeline()
        n1 = pipe.add_node(Filter(query="a"))
        n2 = pipe.add_node(Filter(query="b"))
        assert n1._id != n2._id

    def test_load_structure_accepts_lammps_dump(self):
        # A LAMMPS dump opens standalone via LoadStructure: frame-0 topology with
        # integer atom `type` ids as element proxies.
        pipe = Pipeline()
        n = pipe.add_node(LoadStructure(str(FIXTURES / "water.trj")))
        structure = pipe._structures[n._id]
        assert structure.n_atoms == 3
        assert structure.elements.tolist() == [1, 2, 2]

    def test_add_node_returns_same_instance(self):
        pipe = Pipeline()
        original = Filter(query="test")
        returned = pipe.add_node(original)
        assert returned is original


class TestPipelineAddEdge:
    """Pipeline.add_edge() creates edges with correct port handles."""

    def test_structure_to_filter(self):
        pipe = Pipeline()
        s = pipe.add_node(LoadStructure(str(FIXTURES / "1crn.pdb")))
        f = pipe.add_node(Filter(query="element == 'C'"))
        pipe.add_edge(s.out.particle, f.inp.particle)

        assert len(pipe._edges) == 1
        edge = pipe._edges[0]
        assert edge["source"] == s._id
        assert edge["target"] == f._id
        assert edge["sourceHandle"] == "particle"
        assert edge["targetHandle"] == "in"

    def test_filter_to_modify(self):
        pipe = Pipeline()
        s = pipe.add_node(LoadStructure(str(FIXTURES / "1crn.pdb")))
        f = pipe.add_node(Filter(query="element == 'C'"))
        m = pipe.add_node(Modify(scale=1.3))
        pipe.add_edge(s.out.particle, f.inp.particle)
        pipe.add_edge(f.out.particle, m.inp.particle)

        edge = pipe._edges[1]
        assert edge["sourceHandle"] == "out"
        assert edge["targetHandle"] == "in"

    def test_structure_to_add_bonds(self):
        pipe = Pipeline()
        s = pipe.add_node(LoadStructure(str(FIXTURES / "1crn.pdb")))
        b = pipe.add_node(AddBonds(source="distance"))
        pipe.add_edge(s.out.particle, b.inp.particle)

        edge = pipe._edges[0]
        assert edge["sourceHandle"] == "particle"
        assert edge["targetHandle"] == "particle"

    def test_structure_to_label_generator(self):
        pipe = Pipeline()
        s = pipe.add_node(LoadStructure(str(FIXTURES / "1crn.pdb")))
        lbl = pipe.add_node(AddLabels(source="element"))
        pipe.add_edge(s.out.particle, lbl.inp.particle)

        edge = pipe._edges[0]
        assert edge["sourceHandle"] == "particle"
        assert edge["targetHandle"] == "particle"

    def test_structure_to_viewport_particle(self):
        pipe = Pipeline()
        s = pipe.add_node(LoadStructure(str(FIXTURES / "1crn.pdb")))
        v = pipe.add_node(Viewport())
        pipe.add_edge(s.out.particle, v.inp.particle)

        edge = pipe._edges[0]
        assert edge["sourceHandle"] == "particle"
        assert edge["targetHandle"] == "particle"

    def test_add_bonds_to_viewport_bond(self):
        pipe = Pipeline()
        s = pipe.add_node(LoadStructure(str(FIXTURES / "1crn.pdb")))
        b = pipe.add_node(AddBonds())
        v = pipe.add_node(Viewport())
        pipe.add_edge(s.out.particle, b.inp.particle)
        pipe.add_edge(b.out.bond, v.inp.bond)

        edge = pipe._edges[1]
        assert edge["sourceHandle"] == "bond"
        assert edge["targetHandle"] == "bond"

    def test_trajectory_to_viewport_traj(self):
        pipe = Pipeline()
        s = pipe.add_node(LoadStructure(str(FIXTURES / "caffeine_water.pdb")))
        t = pipe.add_node(
            LoadTrajectory(
                xtc=str(FIXTURES / "caffeine_water_vibration.xtc"),
            )
        )
        v = pipe.add_node(Viewport())
        pipe.add_edge(s.out.particle, t.inp.particle)
        pipe.add_edge(t.out.traj, v.inp.traj)

        traj_edge = pipe._edges[1]
        assert traj_edge["sourceHandle"] == "trajectory"
        assert traj_edge["targetHandle"] == "trajectory"

    def test_error_on_unadded_nodes(self):
        pipe = Pipeline()
        s = LoadStructure("test.pdb")
        f = pipe.add_node(Filter(query="test"))
        with pytest.raises(ValueError, match="must be added"):
            pipe.add_edge(s.out.particle, f.inp.particle)

    def test_error_on_wrong_type_raises_type_error(self):
        """Passing PipelineNode instead of NodePort raises TypeError with guidance."""
        pipe = Pipeline()
        s = pipe.add_node(LoadStructure(str(FIXTURES / "1crn.pdb")))
        f = pipe.add_node(Filter(query="element == 'C'"))
        with pytest.raises(TypeError, match="NodePort"):
            pipe.add_edge(s, f)  # type: ignore[arg-type]

    def test_error_on_cross_pipeline_nodes(self):
        """Ports from a different pipeline instance are rejected."""
        pipe1 = Pipeline()
        s1 = pipe1.add_node(LoadStructure(str(FIXTURES / "1crn.pdb")))

        pipe2 = Pipeline()
        f2 = pipe2.add_node(Filter(query="element == 'C'"))

        with pytest.raises(ValueError, match="must be added"):
            pipe1.add_edge(s1.out.particle, f2.inp.particle)


class TestPipelineSerialization:
    """Pipeline.to_dict() produces valid SerializedPipeline v3."""

    def test_version(self):
        pipe = Pipeline()
        pipe.add_node(LoadStructure(str(FIXTURES / "1crn.pdb")))
        result = pipe.to_dict()
        assert result["version"] == 3

    def test_no_viewport_without_explicit_node(self):
        """Pipeline without Viewport node should not include viewport."""
        pipe = Pipeline()
        pipe.add_node(LoadStructure(str(FIXTURES / "1crn.pdb")))
        result = pipe.to_dict()

        node_types = [n["type"] for n in result["nodes"]]
        assert "viewport" not in node_types

    def test_explicit_viewport_node(self):
        """Viewport node appears when explicitly added."""
        pipe = Pipeline()
        s = pipe.add_node(LoadStructure(str(FIXTURES / "1crn.pdb")))
        v = pipe.add_node(Viewport())
        pipe.add_edge(s.out.particle, v.inp.particle)
        result = pipe.to_dict()

        node_types = [n["type"] for n in result["nodes"]]
        assert "viewport" in node_types
        viewport_edges = [e for e in result["edges"] if e["target"] == v._id]
        assert len(viewport_edges) == 1
        assert viewport_edges[0]["sourceHandle"] == "particle"
        assert viewport_edges[0]["targetHandle"] == "particle"

    def test_viewport_serialization_params(self):
        """Viewport parameters are serialized correctly."""
        pipe = Pipeline()
        pipe.add_node(Viewport(perspective=True, cell_axes_visible=False))
        result = pipe.to_dict()

        vp_node = next(n for n in result["nodes"] if n["type"] == "viewport")
        assert vp_node["perspective"] is True
        assert vp_node["cellAxesVisible"] is False

    def test_viewport_port_resolution(self):
        """add_edge resolves correct ports for various types → viewport."""
        pipe = Pipeline()
        s = pipe.add_node(LoadStructure(str(FIXTURES / "1crn.pdb")))
        b = pipe.add_node(AddBonds(source="distance"))
        lbl = pipe.add_node(AddLabels(source="element"))
        v = pipe.add_node(Viewport())

        pipe.add_edge(s.out.particle, b.inp.particle)
        pipe.add_edge(s.out.particle, lbl.inp.particle)
        pipe.add_edge(s.out.particle, v.inp.particle)
        pipe.add_edge(b.out.bond, v.inp.bond)
        pipe.add_edge(lbl.out.label, v.inp.label)

        result = pipe.to_dict()
        viewport_edges = [e for e in result["edges"] if e["target"] == v._id]
        handles = {(e["sourceHandle"], e["targetHandle"]) for e in viewport_edges}
        assert ("particle", "particle") in handles
        assert ("bond", "bond") in handles
        assert ("label", "label") in handles

    def test_filter_modify_chain(self):
        pipe = Pipeline()
        s = pipe.add_node(LoadStructure(str(FIXTURES / "1crn.pdb")))
        f = pipe.add_node(Filter(query="element == 'C'"))
        m = pipe.add_node(Modify(scale=1.5))
        pipe.add_edge(s.out.particle, f.inp.particle)
        pipe.add_edge(f.out.particle, m.inp.particle)
        result = pipe.to_dict()

        filter_node = next(n for n in result["nodes"] if n["type"] == "filter")
        assert filter_node["query"] == "element == 'C'"

        modify_node = next(n for n in result["nodes"] if n["type"] == "modify")
        assert modify_node["scale"] == 1.5

    def test_replicate_serialization(self):
        pipe = Pipeline()
        s = pipe.add_node(LoadStructure(str(FIXTURES / "1crn.pdb")))
        r = pipe.add_node(Replicate(nx=2, ny=3, nz=4))
        pipe.add_edge(s.out.particle, r.inp.particle)
        pipe.add_edge(s.out.cell, r.inp.cell)
        result = pipe.to_dict()

        rep_node = next(n for n in result["nodes"] if n["type"] == "replicate")
        assert rep_node["nx"] == 2
        assert rep_node["ny"] == 3
        assert rep_node["nz"] == 4

    def test_replicate_round_trip(self):
        pipe = Pipeline()
        s = pipe.add_node(LoadStructure(str(FIXTURES / "1crn.pdb")))
        r = pipe.add_node(Replicate(nx=2, ny=1, nz=3))
        pipe.add_edge(s.out.cell, r.inp.cell)

        pipe2 = Pipeline.from_dict(pipe.to_dict())
        rebuilt = pipe2._nodes[r._id][0]
        assert isinstance(rebuilt, Replicate)
        assert (rebuilt.nx, rebuilt.ny, rebuilt.nz) == (2, 1, 3)

    def test_symmetry_serialization(self):
        pipe = Pipeline()
        s = pipe.add_node(LoadStructure(str(FIXTURES / "1crn.pdb")))
        sym = pipe.add_node(Symmetry(mode="expand"))
        pipe.add_edge(s.out.particle, sym.inp.particle)
        result = pipe.to_dict()

        symmetry_node = next(n for n in result["nodes"] if n["type"] == "symmetry")
        assert symmetry_node["mode"] == "expand"

    def test_symmetry_round_trip(self):
        pipe = Pipeline()
        s = pipe.add_node(LoadStructure(str(FIXTURES / "1crn.pdb")))
        sym = pipe.add_node(Symmetry(mode="none"))
        pipe.add_edge(s.out.particle, sym.inp.particle)

        pipe2 = Pipeline.from_dict(pipe.to_dict())
        rebuilt = pipe2._nodes[sym._id][0]
        assert isinstance(rebuilt, Symmetry)
        assert rebuilt.mode == "none"

    def test_wrap_serialization(self):
        pipe = Pipeline()
        s = pipe.add_node(LoadStructure(str(FIXTURES / "1crn.pdb")))
        w = pipe.add_node(Wrap(mode="wrap"))
        pipe.add_edge(s.out.particle, w.inp.particle)
        result = pipe.to_dict()

        wrap_node = next(n for n in result["nodes"] if n["type"] == "wrap")
        assert wrap_node["mode"] == "wrap"

    def test_wrap_round_trip(self):
        pipe = Pipeline()
        s = pipe.add_node(LoadStructure(str(FIXTURES / "1crn.pdb")))
        w = pipe.add_node(Wrap(mode="unwrap"))
        pipe.add_edge(s.out.particle, w.inp.particle)

        pipe2 = Pipeline.from_dict(pipe.to_dict())
        rebuilt = pipe2._nodes[w._id][0]
        assert isinstance(rebuilt, Wrap)
        assert rebuilt.mode == "unwrap"

    def test_add_bonds_serialization(self):
        pipe = Pipeline()
        s = pipe.add_node(LoadStructure(str(FIXTURES / "1crn.pdb")))
        b = pipe.add_node(AddBonds(source="structure"))
        pipe.add_edge(s.out.particle, b.inp.particle)
        result = pipe.to_dict()

        bond_node = next(n for n in result["nodes"] if n["type"] == "add_bond")
        assert bond_node["bondSource"] == "structure"

    def test_add_bonds_top_serialization(self):
        pipe = Pipeline()
        s = pipe.add_node(LoadStructure(str(FIXTURES / "1crn.pdb")))
        b = pipe.add_node(AddBonds(top=str(FIXTURES / "test_topology.top")))
        pipe.add_edge(s.out.particle, b.inp.particle)
        result = pipe.to_dict()

        bond_node = next(n for n in result["nodes"] if n["type"] == "add_bond")
        assert bond_node["bondSource"] == "file"
        assert bond_node["bondFileName"] == str(FIXTURES / "test_topology.top")
        assert isinstance(bond_node["bondFileData"], list)
        assert len(bond_node["bondFileData"]) > 0

    def test_add_bonds_psf_serialization(self):
        pipe = Pipeline()
        s = pipe.add_node(LoadStructure(str(FIXTURES / "1crn.pdb")))
        b = pipe.add_node(AddBonds(top=str(FIXTURES / "water.psf")))
        pipe.add_edge(s.out.particle, b.inp.particle)
        result = pipe.to_dict()

        bond_node = next(n for n in result["nodes"] if n["type"] == "add_bond")
        assert bond_node["bondSource"] == "file"
        assert bond_node["bondFileName"] == str(FIXTURES / "water.psf")
        assert isinstance(bond_node["bondFileData"], list)
        assert len(bond_node["bondFileData"]) > 0

    def test_color_serialization(self):
        pipe = Pipeline()
        s = pipe.add_node(LoadStructure(str(FIXTURES / "1crn.pdb")))
        c = pipe.add_node(Color(mode="byChain", uniform_color="#abcdef"))
        pipe.add_edge(s.out.particle, c.inp.particle)
        result = pipe.to_dict()

        color_node = next(n for n in result["nodes"] if n["type"] == "color")
        assert color_node["mode"] == "byChain"
        assert color_node["uniformColor"] == "#abcdef"
        assert "range" not in color_node

    def test_color_serialization_with_range(self):
        pipe = Pipeline()
        s = pipe.add_node(LoadStructure(str(FIXTURES / "1crn.pdb")))
        c = pipe.add_node(Color(mode="byBFactor", range=(0.0, 50.0)))
        pipe.add_edge(s.out.particle, c.inp.particle)
        result = pipe.to_dict()

        color_node = next(n for n in result["nodes"] if n["type"] == "color")
        assert color_node["mode"] == "byBFactor"
        assert color_node["range"] == [0.0, 50.0]

    def test_representation_serialization(self):
        pipe = Pipeline()
        s = pipe.add_node(LoadStructure(str(FIXTURES / "1crn.pdb")))
        r = pipe.add_node(Representation(mode="surface"))
        pipe.add_edge(s.out.particle, r.inp.particle)
        result = pipe.to_dict()

        rep_node = next(n for n in result["nodes"] if n["type"] == "representation")
        assert rep_node["mode"] == "surface"

    def test_color_representation_round_trip(self):
        pipe = Pipeline()
        s = pipe.add_node(LoadStructure(str(FIXTURES / "1crn.pdb")))
        c = pipe.add_node(Color(mode="byElement"))
        r = pipe.add_node(Representation(mode="cartoon"))
        v = pipe.add_node(Viewport())
        pipe.add_edge(s.out.particle, c.inp.particle)
        pipe.add_edge(c.out.particle, r.inp.particle)
        pipe.add_edge(r.out.particle, v.inp.particle)

        rebuilt = Pipeline.from_dict(pipe.to_dict())
        types = [config["type"] for _, config in rebuilt._nodes.values()]
        assert "color" in types
        assert "representation" in types

    def test_spectrum_round_trip(self):
        """A spectrum branch survives to_dict() -> from_dict() unchanged."""
        pipe = Pipeline()
        ls = pipe.add_node(LoadSpectrum("ethanol.jdx"))
        sp = pipe.add_node(SpectrumPlot(reverse_x=False, color="#ff0000"))
        pipe.add_edge(ls.out.spectrum, sp.inp.spectrum)
        result = pipe.to_dict()

        load_node = next(n for n in result["nodes"] if n["type"] == "load_spectrum")
        assert load_node["fileName"] == "ethanol.jdx"
        plot_node = next(n for n in result["nodes"] if n["type"] == "spectrum_plot")
        assert plot_node["reverseX"] is False
        assert plot_node["color"] == "#ff0000"

        rebuilt = Pipeline.from_dict(result)
        types = [config["type"] for _, config in rebuilt._nodes.values()]
        assert "load_spectrum" in types
        assert "spectrum_plot" in types

    def test_polyhedra_serialization(self):
        pipe = Pipeline()
        s = pipe.add_node(LoadStructure(str(FIXTURES / "1crn.pdb")))
        boundary = pipe.add_node(DrawingBoundary())
        coordination = pipe.add_node(
            AddCoordination(
                excluded_centers=[26], excluded_ligands=[8], cutoff_tolerance=1.3
            )
        )
        p = pipe.add_node(AddPolyhedra(opacity=0.7))
        pipe.add_edge(s.out.particle, boundary.inp.particle)
        pipe.add_edge(boundary.out.particle, coordination.inp.particle)
        pipe.add_edge(coordination.out.coordination, p.inp.coordination)
        result = pipe.to_dict()

        coordination_node = next(
            n for n in result["nodes"] if n["type"] == "coordination_generator"
        )
        assert coordination_node["excludedCenters"] == [26]
        assert coordination_node["excludedLigands"] == [8]
        assert coordination_node["cutoffTolerance"] == 1.3
        assert coordination_node["boundaryMode"] == "complete"
        poly_node = next(n for n in result["nodes"] if n["type"] == "polyhedron_generator")
        assert poly_node["opacity"] == 0.7
        assert "excludedCenters" not in poly_node

    def test_boundary_completion_round_trip(self):
        pipe = Pipeline()
        node = pipe.add_node(BoundaryCompletion(mode="components"))
        result = pipe.to_dict()
        serialized = next(n for n in result["nodes"] if n["id"] == node._id)
        assert serialized["type"] == "boundary_completion"
        assert serialized["mode"] == "components"

        rebuilt = Pipeline.from_dict(result)
        rebuilt_node = next(
            value for value, config in rebuilt._nodes.values()
            if config["type"] == "boundary_completion"
        )
        assert isinstance(rebuilt_node, BoundaryCompletion)
        assert rebuilt_node.mode == "components"


class TestPipelineDataLoading:
    """Pipeline loads structure data into _node_data."""

    def test_load_structure_populates_node_data(self):
        pipe = Pipeline()
        s = pipe.add_node(LoadStructure(str(FIXTURES / "1crn.pdb")))
        assert s._id in pipe._node_data
        assert len(pipe._node_data[s._id]) > 0
        # Check MEGN magic bytes
        assert pipe._node_data[s._id][:4] == b"MEGN"

    def test_multiple_structures(self):
        pipe = Pipeline()
        s1 = pipe.add_node(LoadStructure(str(FIXTURES / "1crn.pdb")))
        s2 = pipe.add_node(LoadStructure(str(FIXTURES / "caffeine_water.pdb")))
        assert s1._id in pipe._node_data
        assert s2._id in pipe._node_data
        assert s1._id != s2._id

    def test_load_structure_mol2_populates_node_data(self):
        pipe = Pipeline()
        s = pipe.add_node(LoadStructure(str(FIXTURES / "methanol.mol2")))
        assert s._id in pipe._node_data
        assert len(pipe._node_data[s._id]) > 0
        assert pipe._node_data[s._id][:4] == b"MEGN"

    def test_load_structure_cif_populates_node_data(self):
        pipe = Pipeline()
        s = pipe.add_node(LoadStructure(str(FIXTURES / "nacl.cif")))
        assert s._id in pipe._node_data
        assert len(pipe._node_data[s._id]) > 0
        assert pipe._node_data[s._id][:4] == b"MEGN"

    def test_unsupported_format_raises(self, tmp_path):
        # Create a dummy file with unsupported extension
        dummy = tmp_path / "test.unknown"
        dummy.write_text("dummy")
        pipe = Pipeline()
        with pytest.raises(ValueError, match="Unsupported"):
            pipe.add_node(LoadStructure(str(dummy)))

    def test_add_edge_loads_dcd_trajectory(self):
        """Wiring LoadStructure → LoadTrajectory(dcd=...) populates _trajectories."""
        pipe = Pipeline()
        s = pipe.add_node(LoadStructure(str(FIXTURES / "1crn.pdb")))
        t = pipe.add_node(LoadTrajectory(dcd=str(FIXTURES / "water.dcd")))
        pipe.add_edge(s.out.particle, t.inp.particle)
        assert t._id in pipe._trajectories
        assert pipe._trajectories[t._id].n_frames == 5

    def test_add_edge_loads_netcdf_trajectory(self):
        """Wiring LoadStructure → LoadTrajectory(nc=...) populates _trajectories."""
        pipe = Pipeline()
        s = pipe.add_node(LoadStructure(str(FIXTURES / "1crn.pdb")))
        t = pipe.add_node(LoadTrajectory(nc=str(FIXTURES / "water.nc")))
        pipe.add_edge(s.out.particle, t.inp.particle)
        assert t._id in pipe._trajectories
        assert pipe._trajectories[t._id].n_frames == 5

    def test_add_edge_loads_lammpstrj_trajectory(self):
        """Wiring LoadStructure → LoadTrajectory(lammpstrj=...) populates _trajectories."""
        pipe = Pipeline()
        s = pipe.add_node(LoadStructure(str(FIXTURES / "1crn.pdb")))
        t = pipe.add_node(LoadTrajectory(lammpstrj=str(FIXTURES / "water.lammpstrj")))
        pipe.add_edge(s.out.particle, t.inp.particle)
        assert t._id in pipe._trajectories
        assert pipe._trajectories[t._id].n_frames == 3


class TestPipelineDAG:
    """Pipeline supports DAG branching correctly."""

    def test_fan_out_from_structure(self):
        """Multiple downstream nodes from one LoadStructure."""
        pipe = Pipeline()
        s = pipe.add_node(LoadStructure(str(FIXTURES / "1crn.pdb")))
        f1 = pipe.add_node(Filter(query="element == 'C'"))
        f2 = pipe.add_node(Filter(query="element == 'N'"))
        b = pipe.add_node(AddBonds(source="distance"))
        v = pipe.add_node(Viewport())
        pipe.add_edge(s.out.particle, f1.inp.particle)
        pipe.add_edge(s.out.particle, f2.inp.particle)
        pipe.add_edge(s.out.particle, b.inp.particle)
        pipe.add_edge(f1.out.particle, v.inp.particle)
        pipe.add_edge(f2.out.particle, v.inp.particle)
        pipe.add_edge(b.out.bond, v.inp.bond)

        result = pipe.to_dict()
        assert len(result["edges"]) == 6

    def test_chain_filter_modify_labels(self):
        """Filter → Modify and Filter → Labels from same parent."""
        pipe = Pipeline()
        s = pipe.add_node(LoadStructure(str(FIXTURES / "1crn.pdb")))
        f = pipe.add_node(Filter(query="element == 'C'"))
        m = pipe.add_node(Modify(scale=1.3))
        lbl = pipe.add_node(AddLabels(source="element"))
        pipe.add_edge(s.out.particle, f.inp.particle)
        pipe.add_edge(f.out.particle, m.inp.particle)
        pipe.add_edge(f.out.particle, lbl.inp.particle)

        result = pipe.to_dict()
        # f → m: out → in
        fm_edge = next(e for e in result["edges"] if e["source"] == f._id and e["target"] == m._id)
        assert fm_edge["sourceHandle"] == "out"

        # f → lbl: out → particle
        fl_edge = next(e for e in result["edges"] if e["source"] == f._id and e["target"] == lbl._id)
        assert fl_edge["sourceHandle"] == "out"


class TestPipelineJsonExport:
    """Pipeline.to_json() and Pipeline.save() produce correct output."""

    def _make_simple_pipe(self):
        pipe = Pipeline()
        s = pipe.add_node(LoadStructure(str(FIXTURES / "1crn.pdb")))
        bonds = pipe.add_node(AddBonds(source="structure"))
        v = pipe.add_node(Viewport())
        pipe.add_edge(s.out.particle, bonds.inp.particle)
        pipe.add_edge(s.out.particle, v.inp.particle)
        pipe.add_edge(bonds.out.bond, v.inp.bond)
        return pipe

    def test_to_json_returns_string(self):
        pipe = self._make_simple_pipe()
        result = pipe.to_json()
        assert isinstance(result, str)

    def test_to_json_is_valid_json(self):
        import json

        pipe = self._make_simple_pipe()
        d = json.loads(pipe.to_json())
        assert d["version"] == 3
        assert isinstance(d["nodes"], list)
        assert isinstance(d["edges"], list)

    def test_to_json_default_indent(self):
        pipe = self._make_simple_pipe()
        json_str = pipe.to_json()
        # Default indent=2 means the string is not on one line.
        assert "\n" in json_str

    def test_to_json_compact(self):
        pipe = self._make_simple_pipe()
        json_str = pipe.to_json(indent=None)
        assert "\n" not in json_str

    def test_save_creates_file(self, tmp_path):
        pipe = self._make_simple_pipe()
        path = tmp_path / "pipeline.json"
        pipe.save(path)
        assert path.exists()
        assert path.stat().st_size > 0

    def test_save_content_matches_to_json(self, tmp_path):
        pipe = self._make_simple_pipe()
        path = tmp_path / "pipeline.json"
        pipe.save(path)
        assert path.read_text(encoding="utf-8") == pipe.to_json()


class TestPipelineJsonImport:
    """Pipeline.from_dict(), from_json(), and load() reconstruct pipelines."""

    def _make_simple_pipe(self):
        pipe = Pipeline()
        s = pipe.add_node(LoadStructure(str(FIXTURES / "1crn.pdb")))
        bonds = pipe.add_node(AddBonds(source="structure"))
        v = pipe.add_node(Viewport())
        pipe.add_edge(s.out.particle, bonds.inp.particle)
        pipe.add_edge(s.out.particle, v.inp.particle)
        pipe.add_edge(bonds.out.bond, v.inp.bond)
        return pipe

    def test_from_dict_returns_pipeline(self):
        pipe = self._make_simple_pipe()
        pipe2 = Pipeline.from_dict(pipe.to_dict())
        assert isinstance(pipe2, Pipeline)

    def test_from_dict_preserves_node_types(self):
        pipe = self._make_simple_pipe()
        pipe2 = Pipeline.from_dict(pipe.to_dict())
        types1 = [cfg["type"] for _, cfg in pipe._nodes.values()]
        types2 = [cfg["type"] for _, cfg in pipe2._nodes.values()]
        assert types1 == types2

    def test_from_dict_preserves_edges(self):
        pipe = self._make_simple_pipe()
        pipe2 = Pipeline.from_dict(pipe.to_dict())
        assert len(pipe2._edges) == len(pipe._edges)

    def test_from_dict_preserves_node_ids(self):
        pipe = self._make_simple_pipe()
        pipe2 = Pipeline.from_dict(pipe.to_dict())
        assert set(pipe2._nodes.keys()) == set(pipe._nodes.keys())

    def test_from_dict_loads_structure_binary_data(self):
        pipe = self._make_simple_pipe()
        pipe2 = Pipeline.from_dict(pipe.to_dict())
        # Each LoadStructure node ID should have binary data.
        load_ids = [nid for nid, (_, cfg) in pipe2._nodes.items() if cfg["type"] == "load_structure"]
        for nid in load_ids:
            assert nid in pipe2._node_data
            assert pipe2._node_data[nid][:4] == b"MEGN"

    def test_from_dict_round_trip_to_dict(self):
        pipe = self._make_simple_pipe()
        d = pipe.to_dict()
        pipe2 = Pipeline.from_dict(d)
        d2 = pipe2.to_dict()
        assert d["version"] == d2["version"]
        assert len(d["nodes"]) == len(d2["nodes"])
        assert len(d["edges"]) == len(d2["edges"])

    def test_from_dict_counter_advanced(self):
        """After from_dict, add_node should not collide with imported IDs."""
        pipe = self._make_simple_pipe()
        pipe2 = Pipeline.from_dict(pipe.to_dict())
        new_node = pipe2.add_node(Filter(query="element == 'C'"))
        assert new_node._id not in pipe._nodes

    def test_from_json_returns_pipeline(self):
        pipe = self._make_simple_pipe()
        pipe2 = Pipeline.from_json(pipe.to_json())
        assert isinstance(pipe2, Pipeline)
        assert len(pipe2._nodes) == len(pipe._nodes)

    def test_from_json_round_trip(self):
        pipe = self._make_simple_pipe()
        pipe2 = Pipeline.from_json(pipe.to_json())
        assert len(pipe2._edges) == len(pipe._edges)

    def test_load_round_trip(self, tmp_path):
        pipe = self._make_simple_pipe()
        path = tmp_path / "test.json"
        pipe.save(path)
        pipe2 = Pipeline.load(path)
        assert isinstance(pipe2, Pipeline)
        assert len(pipe2._nodes) == len(pipe._nodes)
        assert len(pipe2._edges) == len(pipe._edges)

    def test_load_structure_data_accessible_after_load(self, tmp_path):
        pipe = self._make_simple_pipe()
        path = tmp_path / "test.json"
        pipe.save(path)
        pipe2 = Pipeline.load(path)
        load_ids = [nid for nid, (_, cfg) in pipe2._nodes.items() if cfg["type"] == "load_structure"]
        assert len(load_ids) == 1
        assert load_ids[0] in pipe2._node_data

    def test_from_dict_with_filter_params(self):
        pipe = Pipeline()
        s = pipe.add_node(LoadStructure(str(FIXTURES / "1crn.pdb")))
        f = pipe.add_node(Filter(query="element == 'C'", bond_query="order > 1"))
        v = pipe.add_node(Viewport())
        pipe.add_edge(s.out.particle, f.inp.particle)
        pipe.add_edge(f.out.particle, v.inp.particle)

        pipe2 = Pipeline.from_dict(pipe.to_dict())
        filter_cfg = next(cfg for _, cfg in pipe2._nodes.values() if cfg["type"] == "filter")
        assert filter_cfg["query"] == "element == 'C'"
        assert filter_cfg["bond_query"] == "order > 1"

    def test_from_dict_with_modify_params(self):
        pipe = Pipeline()
        s = pipe.add_node(LoadStructure(str(FIXTURES / "1crn.pdb")))
        m = pipe.add_node(Modify(scale=1.5, opacity=0.7))
        v = pipe.add_node(Viewport())
        pipe.add_edge(s.out.particle, m.inp.particle)
        pipe.add_edge(m.out.particle, v.inp.particle)

        pipe2 = Pipeline.from_dict(pipe.to_dict())
        modify_cfg = next(cfg for _, cfg in pipe2._nodes.values() if cfg["type"] == "modify")
        assert modify_cfg["scale"] == 1.5
        assert modify_cfg["opacity"] == 0.7

    def test_from_dict_with_viewport_params(self):
        pipe = Pipeline()
        pipe.add_node(Viewport(perspective=True, cell_axes_visible=False))

        pipe2 = Pipeline.from_dict(pipe.to_dict())
        vp_cfg = next(cfg for _, cfg in pipe2._nodes.values() if cfg["type"] == "viewport")
        assert vp_cfg["perspective"] is True
        assert vp_cfg["cellAxesVisible"] is False

    def test_load_trajectory_dcd_round_trip(self):
        """LoadTrajectory with .dcd survives to_dict → from_dict."""
        pipe = Pipeline()
        t = pipe.add_node(LoadTrajectory(dcd="run.dcd"))
        traj_cfg = next(cfg for _, cfg in pipe._nodes.values() if cfg["type"] == "load_trajectory")
        assert traj_cfg["fileName"] == "run.dcd"
        pipe2 = Pipeline.from_dict(pipe.to_dict())
        node2: LoadTrajectory = next(n for n, _ in pipe2._nodes.values() if isinstance(n, LoadTrajectory))
        assert node2.dcd == "run.dcd"

    def test_load_trajectory_nc_round_trip(self):
        """LoadTrajectory with .nc survives to_dict → from_dict."""
        pipe = Pipeline()
        pipe.add_node(LoadTrajectory(nc="traj.nc"))
        pipe2 = Pipeline.from_dict(pipe.to_dict())
        node2: LoadTrajectory = next(n for n, _ in pipe2._nodes.values() if isinstance(n, LoadTrajectory))
        assert node2.nc == "traj.nc"

    def test_load_trajectory_lammpstrj_round_trip(self):
        """LoadTrajectory with .lammpstrj survives to_dict → from_dict."""
        pipe = Pipeline()
        pipe.add_node(LoadTrajectory(lammpstrj="dump.lammpstrj"))
        pipe2 = Pipeline.from_dict(pipe.to_dict())
        node2: LoadTrajectory = next(n for n, _ in pipe2._nodes.values() if isinstance(n, LoadTrajectory))
        assert node2.lammpstrj == "dump.lammpstrj"

    def test_load_trajectory_dump_extension_round_trip(self):
        """LoadTrajectory with .dump extension survives to_dict → from_dict."""
        pipe = Pipeline()
        pipe.add_node(LoadTrajectory(lammpstrj="output.dump"))
        pipe2 = Pipeline.from_dict(pipe.to_dict())
        node2: LoadTrajectory = next(n for n, _ in pipe2._nodes.values() if isinstance(n, LoadTrajectory))
        assert node2.lammpstrj == "output.dump"


class TestPipelineJsonImportErrors:
    """from_dict raises clear errors on malformed input."""

    def test_wrong_version_raises(self):
        with pytest.raises(ValueError, match="Unsupported pipeline version"):
            Pipeline.from_dict({"version": 2, "nodes": [], "edges": []})

    def test_missing_version_raises(self):
        with pytest.raises(ValueError, match="Unsupported pipeline version"):
            Pipeline.from_dict({"nodes": [], "edges": []})

    def test_unknown_node_type_raises(self):
        d = {
            "version": 3,
            "nodes": [{"id": "n1", "type": "not_a_real_node"}],
            "edges": [],
        }
        with pytest.raises(ValueError, match="Unknown node type"):
            Pipeline.from_dict(d)

    def test_missing_node_id_raises(self):
        d = {
            "version": 3,
            "nodes": [{"type": "viewport"}],
            "edges": [],
        }
        with pytest.raises(ValueError, match="missing required field 'id'"):
            Pipeline.from_dict(d)

    def test_missing_edge_source_raises(self):
        d = {
            "version": 3,
            "nodes": [],
            "edges": [{"target": "n2", "sourceHandle": "particle", "targetHandle": "particle"}],
        }
        with pytest.raises(ValueError, match="missing required field 'source'"):
            Pipeline.from_dict(d)

    def test_missing_edge_target_raises(self):
        d = {
            "version": 3,
            "nodes": [],
            "edges": [{"source": "n1", "sourceHandle": "particle", "targetHandle": "particle"}],
        }
        with pytest.raises(ValueError, match="missing required field 'target'"):
            Pipeline.from_dict(d)

    def test_from_json_invalid_json_raises(self):
        with pytest.raises(Exception):
            Pipeline.from_json("not valid json {{{")

    def test_load_nonexistent_file_raises(self, tmp_path):
        with pytest.raises(FileNotFoundError):
            Pipeline.load(tmp_path / "does_not_exist.json")


class TestViewWrapper:
    """view() convenience function builds correct pipelines."""

    def test_returns_molecular_viewer(self):
        from megane.widget import MolecularViewer

        viewer = view(str(FIXTURES / "1crn.pdb"))
        assert isinstance(viewer, MolecularViewer)

    def test_pipeline_has_structure_bonds_viewport(self):
        viewer = view(str(FIXTURES / "1crn.pdb"))
        pipe = viewer._pipeline_ref
        node_types = [cfg["type"] for _, cfg in pipe._nodes.values()]
        assert "load_structure" in node_types
        assert "add_bond" in node_types
        assert "viewport" in node_types

    def test_bonds_none_omits_add_bond(self):
        viewer = view(str(FIXTURES / "1crn.pdb"), bonds=None)
        pipe = viewer._pipeline_ref
        node_types = [cfg["type"] for _, cfg in pipe._nodes.values()]
        assert "add_bond" not in node_types

    def test_bonds_structure(self):
        viewer = view(str(FIXTURES / "1crn.pdb"), bonds="structure")
        pipe = viewer._pipeline_ref
        bond_cfg = next(cfg for _, cfg in pipe._nodes.values() if cfg["type"] == "add_bond")
        assert bond_cfg["bondSource"] == "structure"

    def test_viewport_params(self):
        viewer = view(str(FIXTURES / "1crn.pdb"), perspective=True, cell_axes_visible=False)
        pipe = viewer._pipeline_ref
        vp_cfg = next(cfg for _, cfg in pipe._nodes.values() if cfg["type"] == "viewport")
        assert vp_cfg["perspective"] is True
        assert vp_cfg["cellAxesVisible"] is False

    def test_has_node_data(self):
        viewer = view(str(FIXTURES / "1crn.pdb"))
        pipe = viewer._pipeline_ref
        assert len(pipe._node_data) > 0


class TestViewTrajWrapper:
    """view_traj() convenience function builds correct pipelines."""

    def test_returns_molecular_viewer_xtc(self):
        from megane.widget import MolecularViewer

        viewer = view_traj(
            str(FIXTURES / "caffeine_water.pdb"),
            xtc=str(FIXTURES / "caffeine_water_vibration.xtc"),
        )
        assert isinstance(viewer, MolecularViewer)

    def test_pipeline_has_trajectory_node(self):
        viewer = view_traj(
            str(FIXTURES / "caffeine_water.pdb"),
            xtc=str(FIXTURES / "caffeine_water_vibration.xtc"),
        )
        pipe = viewer._pipeline_ref
        node_types = [cfg["type"] for _, cfg in pipe._nodes.values()]
        assert "load_trajectory" in node_types
        assert "load_structure" in node_types
        assert "viewport" in node_types

    def test_total_frames_set(self):
        viewer = view_traj(
            str(FIXTURES / "caffeine_water.pdb"),
            xtc=str(FIXTURES / "caffeine_water_vibration.xtc"),
        )
        assert viewer.total_frames > 0

    def test_raises_without_trajectory(self):
        with pytest.raises(ValueError, match=r"Either 'xtc', 'traj', 'xyz', or 'lammpstrj'"):
            view_traj(str(FIXTURES / "1crn.pdb"))

    def test_auto_detects_lammps_dump(self):
        # A self-contained .trj/.lammpstrj loads standalone: LoadStructure(path)
        # supplies the topology, LoadTrajectory(lammpstrj=path) the frames.
        from megane.widget import MolecularViewer

        viewer = view_traj(str(FIXTURES / "water.trj"))
        assert isinstance(viewer, MolecularViewer)
        pipe = viewer._pipeline_ref
        node_types = [cfg["type"] for _, cfg in pipe._nodes.values()]
        assert "load_structure" in node_types
        assert "load_trajectory" in node_types
        assert viewer.total_frames > 0

    def test_returns_molecular_viewer_traj(self):
        from megane.widget import MolecularViewer

        viewer = view_traj(
            str(FIXTURES / "water_100k.pdb"),
            traj=str(FIXTURES / "water.traj"),
        )
        assert isinstance(viewer, MolecularViewer)
        pipe = viewer._pipeline_ref
        node_types = [cfg["type"] for _, cfg in pipe._nodes.values()]
        assert "load_trajectory" in node_types
        assert viewer.total_frames > 0

    def test_raises_both_xtc_and_traj(self):
        with pytest.raises(ValueError, match="Only one of"):
            view_traj(
                str(FIXTURES / "caffeine_water.pdb"),
                xtc=str(FIXTURES / "caffeine_water_vibration.xtc"),
                traj=str(FIXTURES / "water.traj"),
            )

    def test_bonds_none(self):
        viewer = view_traj(
            str(FIXTURES / "caffeine_water.pdb"),
            xtc=str(FIXTURES / "caffeine_water_vibration.xtc"),
            bonds=None,
        )
        pipe = viewer._pipeline_ref
        node_types = [cfg["type"] for _, cfg in pipe._nodes.values()]
        assert "add_bond" not in node_types

    def test_bonds_auto_default_uses_format_policy(self):
        # "auto" resolves through the shared per-format table (the same one
        # the webapp's load path uses): PDB embeds bonds -> "structure".
        viewer = view_traj(
            str(FIXTURES / "caffeine_water.pdb"),
            xtc=str(FIXTURES / "caffeine_water_vibration.xtc"),
        )
        pipe = viewer._pipeline_ref
        bond_cfg = next(cfg for _, cfg in pipe._nodes.values() if cfg["type"] == "add_bond")
        assert bond_cfg["bondSource"] == "structure"

    def test_bonds_auto_default_distance_for_bondless_formats(self):
        # Multi-frame XYZ carries no bond information -> distance inference.
        viewer = view_traj(str(FIXTURES / "water_multiframe.xyz"))
        pipe = viewer._pipeline_ref
        bond_cfg = next(cfg for _, cfg in pipe._nodes.values() if cfg["type"] == "add_bond")
        assert bond_cfg["bondSource"] == "distance"

    def test_bonds_explicit_distance_overrides_auto(self):
        viewer = view_traj(
            str(FIXTURES / "caffeine_water.pdb"),
            xtc=str(FIXTURES / "caffeine_water_vibration.xtc"),
            bonds="distance",
        )
        pipe = viewer._pipeline_ref
        bond_cfg = next(cfg for _, cfg in pipe._nodes.values() if cfg["type"] == "add_bond")
        assert bond_cfg["bondSource"] == "distance"

    def test_bonds_structure(self):
        viewer = view_traj(
            str(FIXTURES / "caffeine_water.pdb"),
            xtc=str(FIXTURES / "caffeine_water_vibration.xtc"),
            bonds="structure",
        )
        pipe = viewer._pipeline_ref
        bond_cfg = next(cfg for _, cfg in pipe._nodes.values() if cfg["type"] == "add_bond")
        assert bond_cfg["bondSource"] == "structure"

    def test_bonds_file_alias(self):
        viewer = view_traj(
            str(FIXTURES / "caffeine_water.pdb"),
            xtc=str(FIXTURES / "caffeine_water_vibration.xtc"),
            bonds="file",
        )
        pipe = viewer._pipeline_ref
        bond_cfg = next(cfg for _, cfg in pipe._nodes.values() if cfg["type"] == "add_bond")
        assert bond_cfg["bondSource"] == "structure"


class TestBuildPipeline:
    """build_pipeline() convenience function builds correct pipelines."""

    def test_returns_pipeline(self):
        pipe = build_pipeline(str(FIXTURES / "1crn.pdb"))
        assert isinstance(pipe, Pipeline)

    def test_structure_only_has_correct_nodes(self):
        pipe = build_pipeline(str(FIXTURES / "1crn.pdb"))
        node_types = [cfg["type"] for _, cfg in pipe._nodes.values()]
        assert "load_structure" in node_types
        assert "add_bond" in node_types
        assert "viewport" in node_types
        assert "load_trajectory" not in node_types

    def test_bonds_none_omits_add_bond(self):
        pipe = build_pipeline(str(FIXTURES / "1crn.pdb"), bonds=None)
        node_types = [cfg["type"] for _, cfg in pipe._nodes.values()]
        assert "add_bond" not in node_types

    def test_bonds_structure(self):
        pipe = build_pipeline(str(FIXTURES / "1crn.pdb"), bonds="structure")
        bond_cfg = next(cfg for _, cfg in pipe._nodes.values() if cfg["type"] == "add_bond")
        assert bond_cfg["bondSource"] == "structure"

    def test_bonds_file_alias(self):
        pipe = build_pipeline(str(FIXTURES / "1crn.pdb"), bonds="file")
        bond_cfg = next(cfg for _, cfg in pipe._nodes.values() if cfg["type"] == "add_bond")
        assert bond_cfg["bondSource"] == "structure"

    def test_viewport_params(self):
        pipe = build_pipeline(
            str(FIXTURES / "1crn.pdb"),
            perspective=True,
            cell_axes_visible=False,
            pivot_marker_visible=False,
        )
        vp_cfg = next(cfg for _, cfg in pipe._nodes.values() if cfg["type"] == "viewport")
        assert vp_cfg["perspective"] is True
        assert vp_cfg["cellAxesVisible"] is False
        assert vp_cfg["pivotMarkerVisible"] is False

    def test_has_node_data(self):
        pipe = build_pipeline(str(FIXTURES / "1crn.pdb"))
        assert len(pipe._node_data) > 0

    def test_to_json_produces_valid_json(self):
        import json

        pipe = build_pipeline(str(FIXTURES / "1crn.pdb"))
        d = json.loads(pipe.to_json())
        assert d["version"] == 3

    def test_with_xtc_trajectory(self):
        pipe = build_pipeline(
            str(FIXTURES / "caffeine_water.pdb"),
            xtc=str(FIXTURES / "caffeine_water_vibration.xtc"),
        )
        node_types = [cfg["type"] for _, cfg in pipe._nodes.values()]
        assert "load_trajectory" in node_types
        assert "load_structure" in node_types
        assert "viewport" in node_types
        assert len(pipe._trajectories) > 0

    def test_raises_both_xtc_and_traj(self):
        with pytest.raises(ValueError, match="Only one of"):
            build_pipeline(
                str(FIXTURES / "caffeine_water.pdb"),
                xtc=str(FIXTURES / "caffeine_water_vibration.xtc"),
                traj=str(FIXTURES / "water.traj"),
            )

    def test_compatible_with_set_pipeline(self):
        from megane.widget import MolecularViewer

        pipe = build_pipeline(str(FIXTURES / "1crn.pdb"))
        viewer = MolecularViewer()
        viewer.set_pipeline(pipe)
        assert viewer._pipeline_json != ""
        assert len(viewer._node_snapshots_data) > 0

    def test_with_top_topology(self):
        pipe = build_pipeline(
            str(FIXTURES / "1crn.pdb"),
            top=str(FIXTURES / "test_topology.top"),
        )
        node_types = [cfg["type"] for _, cfg in pipe._nodes.values()]
        assert "add_bond" in node_types
        bond_cfg = next(cfg for _, cfg in pipe._nodes.values() if cfg["type"] == "add_bond")
        assert bond_cfg["bondSource"] == "file"
        assert "bondFileData" in bond_cfg
        assert isinstance(bond_cfg["bondFileData"], list)
        assert len(bond_cfg["bondFileData"]) == 8  # 4 bonds * 2

    def test_top_overrides_bonds(self):
        pipe = build_pipeline(
            str(FIXTURES / "1crn.pdb"),
            bonds="distance",
            top=str(FIXTURES / "test_topology.top"),
        )
        bond_cfg = next(cfg for _, cfg in pipe._nodes.values() if cfg["type"] == "add_bond")
        assert bond_cfg["bondSource"] == "file"

    def test_top_json_includes_bond_data(self):
        import json

        pipe = build_pipeline(
            str(FIXTURES / "1crn.pdb"),
            top=str(FIXTURES / "test_topology.top"),
        )
        d = json.loads(pipe.to_json())
        bond_node = next(n for n in d["nodes"] if n["type"] == "add_bond")
        assert bond_node["bondSource"] == "file"
        assert bond_node["bondFileData"] == [0, 1, 1, 2, 2, 3, 1, 4]
