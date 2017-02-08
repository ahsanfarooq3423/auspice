import React from "react";
import d3 from "d3";
import * as globals from "../../util/globals";
import Card from "../framework/card";
import Legend from "../controls/legend";
import ZoomOutIcon from "../framework/zoom-out-icon";
import ZoomInIcon from "../framework/zoom-in-icon";
import MoveIcon from "../framework/move-icon";
import PhyloTree from "../../util/phyloTree";
import {ReactSVGPanZoom, fitToViewer} from "react-svg-pan-zoom";
import ReactDOM from "react-dom";
import {Viewer, ViewerHelper} from 'react-svg-pan-zoom';
import {fastTransitionDuration, mediumTransitionDuration, slowTransitionDuration} from "../../util/globals";
import * as globalStyles from "../../globalStyles";
import InfoPanel from "./infoPanel";
import { connect } from "react-redux";
import computeResponsive from "../../util/computeResponsive";
import { getGenotype } from "../../util/getGenotype";
import { arrayInEquality,
         branchThickness,
         tipRadii,
         tipVisibility,
         nodeColor} from "../../util/treeHelpers";

/* UNDERSTANDING THIS CODE:
the "tree" object passed in from redux (this.props.tree)
contains the nodes etc used to build the PhyloTree
object called tree (!). Those nodes are in a 1-1 ordering, and
there are actually backlinks from the phylotree tree
(i.e. tree.nodes[i].n links to props.tree.nodes[i])

I (james) don't want to put phylotree into redux
as it's not simply data

the state of this component contains a few flags and
hovered / clicked, which reference the nodes currently in that state
they're not in redux as (1) its easier and (2) all components that
need this information are children of this component
(it would probably be a good idea to move them to redux)
*/


/*
 * TreeView creates a (now responsive!) SVG & scales according to layout
 * such that branches and tips are correctly placed.
 * also handles zooming
*/
@connect((state) => {
  return {
    tree: state.tree,
    metadata: state.metadata.metadata,
    colorOptions: state.metadata.colorOptions,
    browserDimensions: state.browserDimensions.browserDimensions,
    layout: state.controls.layout,
    distanceMeasure: state.controls.distanceMeasure,
    sequences: state.sequences,
    selectedLegendItem: state.controls.selectedLegendItem,
    colorScale: state.controls.colorScale,
    datasetGuid: state.tree.datasetGuid,
    dateMin: state.controls.dateMin,
    dateMax: state.controls.dateMax
  };
})
class TreeView extends React.Component {
  constructor(props) {
    super(props);
    this.Viewer = null;
    this.state = {
      tool: "pan",  //one of `none`, `pan`, `zoom`, `zoom-in`, `zoom-out`
      clicked: null,
      hover: null,
      tree: null,
      shouldReRender: false // start off this way I guess
    };
  }

  static contextTypes = {
    router: React.PropTypes.object.isRequired
  }

  static propTypes = {
  }

  componentWillReceiveProps(nextProps) {
    /*
    This both creates the tree (when it's loaded into redux) and
    works out what to update, based upon changes to redux.control

    NB logic was previously in CDM, but now we wait for browserDimensions
    */
    let tree = this.state.tree
    /* should we create a new tree (dataset change) */

    if ((nextProps.datasetGuid !== this.props.datasetGuid && nextProps.tree.nodes) ||
        (!tree && nextProps.datasetGuid && nextProps.tree.nodes)) {
      tree = this.makeTree(nextProps.tree.nodes)
      console.log("making tree")
      this.setState({tree, shouldReRender: true});
      if (this.Viewer) {
        this.Viewer.fitToViewer();
      }
    }

    /* if we have a tree and we have new props, figure out what we need to update...
    this is imperitive, as opposed to redux-style coding, due to the fact
    that redrawing the tree is expensive, so we try and do the least amount
    of work possible */
    if (tree) {
      /* the objects storing the changes to make to the tree */
      const tipAttrToUpdate = {};
      const tipStyleToUpdate = {};
      const branchAttrToUpdate = {};
      const branchStyleToUpdate = {};

      /* calculate all changes resulting from ∆ colorScale */
      if (this.props.colorScale.version !== nextProps.colorScale.version) {
        const newNodeColor = nodeColor(nextProps.tree, nextProps.colorScale, nextProps.sequences);
        tipStyleToUpdate["fill"] = newNodeColor.map((col) => {
          return d3.rgb(col).brighter([0.65]).toString();
        });
        tipStyleToUpdate["stroke"] = newNodeColor;
        branchStyleToUpdate["stroke"] = newNodeColor.map((col) => {
          return d3.rgb(d3.interpolateRgb(col, "#BBB")(0.6)).toString();
        });
      }

      /* tip radii change when the selectedLegendItem changes*/
      if (this.props.selectedLegendItem !== nextProps.selectedLegendItem) {
        tipAttrToUpdate["r"] = tipRadii(nextProps.selectedLegendItem, nextProps.colorScale, nextProps.sequences, nextProps.tree);
      }

      /* tip visibility has changed, for instance because of date slider */
      /* to do: find a smarter way to check for changes here */
      /* BUG (react router v4)
      should perhaps pass in the previous history location to prevTip...
      https://github.com/ReactTraining/history#properties
      */
      const prevTipVisibility = tipVisibility(this.props.tree, this.props.metadata, this.props.dateMin, this.props.dateMax, this.props.query);
      const newTipVisibility = tipVisibility(nextProps.tree, nextProps.metadata, nextProps.dateMin, nextProps.dateMax, nextProps.query);
      if (arrayInEquality(prevTipVisibility, newTipVisibility)) {
        tipStyleToUpdate["visibility"] = newTipVisibility;
      }


      /* branches change thickness if the (active) tip count changes */
      if (this.props.tree.nodes[0].fullTipCount !== nextProps.tree.nodes[0].fullTipCount) {
        branchStyleToUpdate["stroke-width"] = branchThickness(nextProps.tree)
      }

      /* implement style changes */
      if (Object.keys(branchAttrToUpdate).length || Object.keys(branchStyleToUpdate).length) {
        tree.updateMultipleArray(".branch", branchAttrToUpdate, branchStyleToUpdate, fastTransitionDuration);
      }
      if (Object.keys(tipAttrToUpdate).length || Object.keys(tipStyleToUpdate).length) {
        tree.updateMultipleArray(".tip", tipAttrToUpdate, tipStyleToUpdate, fastTransitionDuration);
      }

      /* swap layouts */
      if (this.props.layout !== nextProps.layout) {
        tree.updateLayout(nextProps.layout, slowTransitionDuration);
      }
      /* change distance metrics */
      if (this.props.distanceMeasure !== nextProps.distanceMeasure) {
        tree.updateDistance(nextProps.distanceMeasure, slowTransitionDuration);
      }
    }
  }

  shouldComponentUpdate(nextProps, nextState) {
    /* reconcile hover and click selections in tree
    used to be in componentWillReceiveProps, however
    by having it here we both get access to nextState and can
    control whether this component re-renders
    */
    if (
      this.state.tree &&
      (this.state.hovered || this.state.clicked) &&
      this.props.layout === nextProps.layout // this block interferes with layout transition otherwise
    ) {
      /* check whether or not the previously selected item was clicked */
      if (this.state.clicked && nextState.clicked) { // was the previous item a click?
        this.state.tree.updateSelectedBranchOrTip(
          this.state.clicked, /* turn this one off */
          nextState.clicked, /* turn this one on */
        );
      } else if (this.state.hovered && nextState.clicked) { // previously a hover, now a click
        this.state.tree.updateSelectedBranchOrTip(
          this.state.hovered,
          nextState.clicked,
        );
      } else if (this.state.hovered && nextState.hovered) { // deselect the previously selected hover
        this.state.tree.updateSelectedBranchOrTip(
          this.state.hovered,
          nextState.hovered,
        );
      } else if (this.state.clicked && nextState.clicked === null) {
        // x clicked or clicked off will give a null value, so reset everything to be safe
        this.state.tree.updateSelectedBranchOrTip(
          this.state.clicked,
          null
        )
      }
    }
    /* we are now in a position to control the rendering to improve performance */
    if (nextState.shouldReRender) {
      // console.log("SCU returning true")
      this.setState({shouldReRender: false});
      return true;
    }
    // console.log("SCU returning false")
    return false
  }

  componentDidUpdate(prevProps, prevState) {
    if (
      this.state.tree && /* tree exists */
      prevProps.browserDimensions && /* it's not the first render, the listener is registered and width/height passed in */
      this.props.browserDimensions &&
      (prevProps.browserDimensions.width !== this.props.browserDimensions.width || /* the browser dimensions have changed */
      prevProps.browserDimensions.height !== this.props.browserDimensions.height)
    ) {
      this.state.tree.zoomIntoClade(this.state.tree.nodes[0], mediumTransitionDuration);
    }
  }

  makeTree(nodes) {
    if (nodes && this.refs.d3TreeElement) {
      var myTree = new PhyloTree(nodes[0]);
      // https://facebook.github.io/react/docs/refs-and-the-dom.html
      var treeplot = d3.select(this.refs.d3TreeElement);
      myTree.render(
        treeplot,
        this.props.layout,
        this.props.distanceMeasure,
        {
          /* options */
          grid: true,
          confidence: false
        },
        {
          /* callbacks */
          onTipHover: this.onTipHover.bind(this),
          onTipClick: this.onTipClick.bind(this),
          onBranchHover: this.onBranchHover.bind(this),
          onBranchClick: this.onBranchClick.bind(this),
          onBranchOrTipLeave: this.onBranchOrTipLeave.bind(this)
        },
        {
          /* presently selected node / branch */
          hovered: this.state.hovered,
          clicked: this.state.clicked
        }
      );
      // Update the branch thickness - perhaps this could be better...
      myTree.updateMultipleArray(".branch", {}, {"stroke-width": branchThickness(this.props.tree)}, fastTransitionDuration);
      return myTree;
    } else {
      return null;
    }
  }

  /* Callbacks used by the tips / branches when hovered / clicked */
  /* By keeping this out of redux I think it makes things a little faster */
  onTipHover(d) {
    if (!this.state.clicked) {
      this.setState({hovered: {d, type: ".tip"}});
    }
  }
  onTipClick(d) {
    this.setState({clicked: {d,type: ".tip"}, hovered: null});
  }
  onBranchHover(d) {
    if (!this.state.clicked) {
      this.setState({hovered: {d,type: ".branch"}});
    }
  }
  onBranchClick(d) {
    this.setState({clicked: {d, type: ".branch"},hovered: null});
  }
  // mouse out from tip/branch
  onBranchOrTipLeave(){
    if (this.state.hovered) {
      this.setState({hovered: null})
    }
  }

  handleIconClick(tool) {
    return () => {
      if (tool === "zoom-in") {
        this.Viewer.zoomOnViewerCenter(1.1);
        // console.log('zooming in', this.state.zoom, zoom)
      } else {
        this.Viewer.zoomOnViewerCenter(0.9);
      }
      // const viewerX = this.state.width / 2;
      // const viewerY = this.treePlotHeight(this.state.width) / 2;
      // const nextValue = ViewerHelper.zoom(this.state.value, zoom, viewerX, viewerY);
      // this.setState({value: nextValue});
    };
  }

  // handleZoomEvent(direction) {
  //   return () => {
  //     this.state.value.matrix
  //     console.log(direction)
  //   }
  // }
  // handleChange(value) {
  //   console.log("handleChange not yet implemented", value)
  // }
  // handleClick(event){
  //   console.log('handleClick not yet implemented', event)
  //   // console.log('click', event.x, event.y, event.originalEvent);
  // }

  infoPanelDismiss() {
    this.setState({clicked: null, hovered: null});
    this.state.tree.zoomIntoClade(this.state.tree.nodes[0], mediumTransitionDuration);
  }

  createTreeMarkup() {
    const responsive = computeResponsive({
      horizontal: this.props.browserDimensions && this.props.browserDimensions.width > globals.twoColumnBreakpoint ? .5 : 1,
      vertical: 1,
      browserDimensions: this.props.browserDimensions,
      sidebar: this.props.sidebar,
      split: false,
      extraPadding: 0
    })

    /* NOTE these props were removed from SVG pan-zoom as they led to functions that did
    nothing, but they may be useful in the future...
    onChangeValue={this.handleChange.bind(this)}
    onClick={this.handleClick.bind(this)}
    */

    return (
      <Card center title="Phylogeny">
        <svg
          width={300}
          height={250 /* this should be dynamically calculated by number of elements */}
          style={{
            position: "absolute",
            left: 13,
            top: 45,
            borderRadius: 10,
            zIndex: 1000,
            backgroundColor: "rgba(255,255,255,.85)"
          }}>
          <Legend colorScale={this.props.colorScale}/>
        </svg>
        <InfoPanel
          dismiss={this.infoPanelDismiss.bind(this)}
          zoom={this.state.tree ? this.state.tree.zoomIntoClade.bind(this.state.tree) : null}
          hovered={this.state.hovered}
          clicked={this.state.clicked}/>
        <ReactSVGPanZoom
          width={responsive ? responsive.width : 1}
          height={responsive ? responsive.height : 1}
          ref={(Viewer) => {
            // https://facebook.github.io/react/docs/refs-and-the-dom.html
            this.Viewer = Viewer
          }}
          style={{cursor: "default"}}
          tool={this.state.tool}
          detectWheel={false}
          toolbarPosition={"none"}
          detectAutoPan={false}
          background={"#FFF"}>
          <svg style={{pointerEvents: "auto"}}
            width={responsive.width}
            height={responsive.height}
            >
            <g
              width={responsive.width}
              height={responsive.height}
              style={{cursor: "default"}}
              ref="d3TreeElement">
            </g>
          </svg>
        </ReactSVGPanZoom>
        <svg width={50} height={130}
             style={{position: "absolute", right: 20, bottom: 20}}>
            <defs>
              <filter id="dropshadow" height="130%">
                <feGaussianBlur in="SourceAlpha" stdDeviation="3"/>
                <feOffset dx="2" dy="2" result="offsetblur"/>
                <feComponentTransfer>
                  <feFuncA type="linear" slope="0.2"/>
                </feComponentTransfer>
                <feMerge>
                  <feMergeNode/>
                  <feMergeNode in="SourceGraphic"/>
                </feMerge>
              </filter>
            </defs>
          <ZoomInIcon
            handleClick={this.handleIconClick("zoom-in")}
            active={true}
            x={10}
            y={50}
            />
          <ZoomOutIcon
            handleClick={this.handleIconClick("zoom-out")}
            active={true}
            x={10}
            y={90}
            />
        </svg>
      </Card>
    )
  }
  render() {
    /*
      1. set up SVGs
      2. tree will be added on props loading
    */
    console.log("treeView render")
    return (
      <span>
        {this.props.browserDimensions ? this.createTreeMarkup() : null}
      </span>
    );
  }
}

export default TreeView;
