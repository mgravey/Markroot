/*
 * Markroot logo animation generator for Adobe After Effects.
 * Run with File > Scripts > Run Script File… then export the generated
 * MARKROOT_LOGO_ANIMATION composition with Bodymovin/LottieFiles.
 *
 * The artwork intentionally uses only shape paths, fills, strokes, trim paths,
 * opacity, position, and scale so the result stays friendly to Lottie renderers.
 */
(function buildMarkrootLogo() {
    app.beginUndoGroup("Build Markroot logo animation");

    if (!app.project) app.newProject();

    var FPS = 30;
    var comp = app.project.items.addComp("MARKROOT_LOGO_ANIMATION", 512, 512, 1, 2.4, FPS);
    comp.bgColor = [0.929, 0.941, 0.933];

    function rgb(hex) {
        return [parseInt(hex.substr(1, 2), 16) / 255, parseInt(hex.substr(3, 2), 16) / 255, parseInt(hex.substr(5, 2), 16) / 255];
    }

    function frame(n) { return n / FPS; }

    function setKeys(property, keys) {
        for (var i = 0; i < keys.length; i++) property.setValueAtTime(frame(keys[i][0]), keys[i][1]);
    }

    function shapePath(vertices, inTangents, outTangents, closed) {
        var shape = new Shape();
        shape.vertices = vertices;
        shape.inTangents = inTangents;
        shape.outTangents = outTangents;
        shape.closed = closed;
        return shape;
    }

    function addPath(layer, name, shape, strokeColor, strokeWidth) {
        var group = layer.property("ADBE Root Vectors Group").addProperty("ADBE Vector Group");
        group.name = name;
        var contents = group.property("ADBE Vectors Group");
        var path = contents.addProperty("ADBE Vector Shape - Group");
        path.property("ADBE Vector Shape").setValue(shape);
        var stroke = contents.addProperty("ADBE Vector Graphic - Stroke");
        stroke.property("ADBE Vector Stroke Color").setValue(strokeColor);
        stroke.property("ADBE Vector Stroke Width").setValue(strokeWidth);
        stroke.property("ADBE Vector Stroke Line Cap").setValue(2);
        stroke.property("ADBE Vector Stroke Line Join").setValue(2);
        var trim = contents.addProperty("ADBE Vector Filter - Trim");
        return trim.property("ADBE Vector Trim End");
    }

    function addFilledPath(layer, name, shape, fillColor) {
        var group = layer.property("ADBE Root Vectors Group").addProperty("ADBE Vector Group");
        group.name = name;
        var contents = group.property("ADBE Vectors Group");
        var path = contents.addProperty("ADBE Vector Shape - Group");
        path.property("ADBE Vector Shape").setValue(shape);
        var fill = contents.addProperty("ADBE Vector Graphic - Fill");
        fill.property("ADBE Vector Fill Color").setValue(fillColor);
    }

    function addEllipse(layer, name, size, fillColor) {
        var group = layer.property("ADBE Root Vectors Group").addProperty("ADBE Vector Group");
        group.name = name;
        var contents = group.property("ADBE Vectors Group");
        var ellipse = contents.addProperty("ADBE Vector Shape - Ellipse");
        ellipse.property("ADBE Vector Ellipse Size").setValue(size);
        var fill = contents.addProperty("ADBE Vector Graphic - Fill");
        fill.property("ADBE Vector Fill Color").setValue(fillColor);
    }

    function addRectangle(layer, name, size, fillColor) {
        var group = layer.property("ADBE Root Vectors Group").addProperty("ADBE Vector Group");
        group.name = name;
        var contents = group.property("ADBE Vectors Group");
        var rect = contents.addProperty("ADBE Vector Shape - Rect");
        rect.property("ADBE Vector Rect Size").setValue(size);
        var fill = contents.addProperty("ADBE Vector Graphic - Fill");
        fill.property("ADBE Vector Fill Color").setValue(fillColor);
    }

    var teal = rgb("#006f62");
    var white = rgb("#ffffff");
    var orange = rgb("#ef9163");
    var zero = [0, 0];

    var tile = comp.layers.addShape();
    tile.name = "01 Tile · teal field";
    tile.property("ADBE Transform Group").property("ADBE Position").setValue([256, 256]);
    addFilledPath(tile, "Asymmetric rounded tile", shapePath(
        [[-112,-208],[112,-208],[208,-112],[208,144],[144,208],[-112,208],[-208,112],[-208,-112]],
        [[-53,0],[-53,0],[0,-53],[0,-35],[35,0],[53,0],[0,53],[0,53]],
        [[53,0],[53,0],[0,53],[0,35],[-35,0],[-53,0],[0,-53],[0,-53]], true
    ), teal);
    setKeys(tile.property("ADBE Transform Group").property("ADBE Scale"), [[4,[0,0]],[13,[106,106]],[19,[100,100]]]);

    var roots = comp.layers.addShape();
    roots.name = "02 Roots · grow first";
    roots.property("ADBE Transform Group").property("ADBE Position").setValue([256,256]);
    var rootEnd1 = addPath(roots, "Left root", shapePath([[6,90],[-51,126]],[zero,zero],[zero,zero],false), white, 32);
    var rootEnd2 = addPath(roots, "Tap root", shapePath([[6,90],[6,143]],[zero,zero],[zero,zero],false), white, 32);
    var rootEnd3 = addPath(roots, "Right root", shapePath([[6,90],[65,126]],[zero,zero],[zero,zero],false), white, 32);
    setKeys(rootEnd1, [[10,0],[29,100]]); setKeys(rootEnd2, [[10,0],[29,100]]); setKeys(rootEnd3, [[10,0],[29,100]]);

    var stems = comp.layers.addShape();
    stems.name = "03 Pilcrow stems · rise";
    stems.property("ADBE Transform Group").property("ADBE Position").setValue([256,256]);
    var stemEnd = addPath(stems, "Main stem", shapePath([[6,90],[6,-100]],[zero,zero],[zero,zero],false), white, 32);
    var secondEnd = addPath(stems, "Second stem", shapePath([[70,44],[70,-100]],[zero,zero],[zero,zero],false), white, 32);
    setKeys(stemEnd, [[23,0],[43,100]]); setKeys(secondEnd, [[29,0],[46,100]]);

    var bowl = comp.layers.addShape();
    bowl.name = "04 Pilcrow bowl · write on";
    bowl.property("ADBE Transform Group").property("ADBE Position").setValue([256,256]);
    var bowlEnd = addPath(bowl, "Bowl", shapePath(
        [[70,-100],[-24,-100],[-108,-28],[-24,44],[6,44]],
        [[zero[0],zero[1]],[-42,0],[0,-42],[-42,0],[-15,0]],
        [[zero[0],zero[1]],[-42,0],[0,42],[15,0],[zero[0],zero[1]]], false
    ), white, 32);
    setKeys(bowlEnd, [[38,0],[58,100]]);

    var seed = comp.layers.addShape();
    seed.name = "05 Seed · opening beat";
    seed.property("ADBE Transform Group").property("ADBE Position").setValue([262,399]);
    addEllipse(seed, "Orange seed", [30,30], orange);
    setKeys(seed.property("ADBE Transform Group").property("ADBE Scale"), [[0,[0,0]],[5,[120,120]],[10,[100,100]],[17,[0,0]]]);

    var cursor = comp.layers.addShape();
    cursor.name = "06 Cursor · final accent";
    cursor.property("ADBE Transform Group").property("ADBE Position").setValue([366,160]);
    addRectangle(cursor, "Orange cursor", [24,64], orange);
    setKeys(cursor.property("ADBE Transform Group").property("ADBE Opacity"), [[0,0],[52,0],[56,100],[62,100],[64,0],[67,0],[69,100],[71,100]]);

    comp.markerProperty.setValueAtTime(frame(0), new MarkerValue("seed"));
    comp.markerProperty.setValueAtTime(frame(10), new MarkerValue("root"));
    comp.markerProperty.setValueAtTime(frame(29), new MarkerValue("stem"));
    comp.markerProperty.setValueAtTime(frame(38), new MarkerValue("write"));
    comp.markerProperty.setValueAtTime(frame(58), new MarkerValue("final-logo"));
    comp.workAreaStart = 0;
    comp.workAreaDuration = comp.duration;

    app.endUndoGroup();
    alert("Markroot animation created. Export MARKROOT_LOGO_ANIMATION with Bodymovin/LottieFiles.");
})();
