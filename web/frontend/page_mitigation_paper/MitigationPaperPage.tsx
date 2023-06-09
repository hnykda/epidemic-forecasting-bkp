import * as chroma from "chroma-js";
import * as d3 from "d3";
import { median, std, quantileSeq } from "mathjs";
import * as React from "react";
import * as ReactDOM from "react-dom";

import {
  Measure,
  MeasureGroup,
  measures,
  range,
  changeLimit,
  serialInterval,
} from "./measures";
import { calculateMultiplied } from "./multiplier";

function p(v: number): string {
  return `${(100 * v).toFixed(5)}%`;
}

function calculateBackground(
  mean: number,
  sd: number,
  min: number,
  max: number,
  thumbWidth: string,
  scale: chroma.Scale,
  ticks: boolean,
  leftToRight: boolean
): string {
  function getColor(z: number) {
    return scale(Math.exp((z * z) / -2)).css();
  }

  let backgrounds = [];
  let gradientDirection = leftToRight ? "right" : "left";
  const f = (loc: number) => getColor((loc - mean) / sd);
  backgrounds.push(`linear-gradient(
    to ${gradientDirection}, ${f(min)} 49%, ${f(max)} 51%)`);

  let stops: Array<string> = [];
  let addStop = (loc: number, z: number) => {
    let offset = (loc - min) / (max - min);
    stops.push(`${getColor(z)} ${(offset * 100).toFixed(2)}%`);
  };

  for (let z = -4; z < 4; z += 0.25) {
    addStop(mean + z * sd, z);
  }

  let rulerGradient = `linear-gradient(to ${gradientDirection}, ${stops.join(
    ","
  )})`;
  backgrounds.push(
    `no-repeat ${rulerGradient} 
      calc(${thumbWidth}/2) 0 
    / calc(100% - ${thumbWidth}) auto`
  );

  function addTicks(
    interval: number,
    height: number,
    color: string,
    color2: string,
    pos?: number,
    w: number = 1
  ) {
    let firstTick = pos ?? Math.ceil(min / interval) * interval;

    let offset = p((firstTick - min) / (max - min));

    let tickSpace = p(interval / (max - min));
    // let tickGradient = `repeating-linear-gradient(to right,
    //   ${color}, ${color} 1px,
    //   transparent 1px, transparent ${tickSpace}
    // )`;
    let tickGradient = `${
      pos === undefined ? "repeating-linear-gradient" : "linear-gradient"
    }(to ${gradientDirection}, 
      transparent calc(${offset}), ${color} calc(${offset}),
      ${color} calc(${offset} + ${w}px), ${color2} calc(${offset} + ${w}px), 
      ${color2} calc(${offset} + ${2 * w}px), transparent calc(${offset} + ${
      2 * w
    }px)
      ${
        pos !== undefined ? "" : `, transparent calc(${offset} + ${tickSpace})`
      } 
    )`;
    backgrounds.push(
      `no-repeat ${tickGradient} 
        calc(${thumbWidth} / 2) bottom 
      / calc(100% - ${thumbWidth}) ${p(height)}`
    );
  }
  let dark = scale(1).desaturate().css();
  let light = scale(0.5).desaturate().css();

  if (ticks) {
    if (max < 2) {
      addTicks(0.05, 0.2, dark, light);
      addTicks(0.1, 0.5, dark, light);
    } else if (max - min < 4) {
      addTicks(0.1, 0.2, dark, light);
      addTicks(1, 0.5, dark, light);
    } else {
      addTicks(0.5, 0.2, dark, light);
      addTicks(1, 0.5, dark, light);
    }

    addTicks(1, 1, dark, scale(0.4).desaturate().css(), 1, 2);
  }

  return backgrounds.reverse().join(", ");
}

namespace FancySlider {
  export interface Props {
    mean: number;
    sd: number;
    disabled?: boolean;
    initial?: number;
    row: number;
    step: number;
    min: number;
    max: number;
    value: number;
    scale?: chroma.Scale;
    onChange?: (value: number) => void;
    format?: "percentage" | "absolute";
    direction?: "rtl" | "ltr";
    ticks?: boolean;
  }
}

function FancySlider({
  onChange,
  mean,
  sd,
  initial: propInitial,
  min: propMin,
  max: propMax,
  step,
  row,
  disabled: propDisabled,
  value: propValue,
  format: propFormat,
  scale,
  direction,
  ticks,
}: FancySlider.Props) {
  let format =
    propFormat == "percentage"
      ? (x: number) => d3.format("+.0%")(x - 1)
      : (x: number) => x.toFixed(1);
  const [initial] = React.useState(propInitial ?? mean);
  let disabled = propDisabled ?? false;
  let min = Math.floor(propMin / step) * step;
  let max = Math.ceil(propMax / step) * step;
  let value = Math.round(propValue / step) * step;

  const background = React.useMemo(() => {
    return calculateBackground(
      mean,
      Math.abs(sd),
      propMin,
      propMax,
      onChange !== undefined ? "var(--thumb-width)" : "3px",
      scale ?? chroma.scale("YlGnBu"),
      ticks ?? false,
      (direction ?? "ltr") == "ltr"
    );
  }, [onChange, mean, sd, min, max]);

  let input: JSX.Element;
  if (onChange) {
    let lin: (x: number) => number = (x) => x;
    let inv: (x: number) => number = (x) => x;
    let aff: (x: number) => number = (x) => x;
    if (propFormat == "percentage") {
      lin = (x) => 100 * (x - 1);
      inv = (x) => 1 + x / 100;
      aff = (x) => 100 * x;
    }

    input = (
      <div className="input-group">
        <div className="input-group-prepend">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => onChange(initial)}
          >
            ↻
          </button>
        </div>
        <input
          className="form-control"
          min={lin(min)}
          max={lin(max)}
          step={aff(step)}
          type="number"
          onChange={(evt) => onChange(inv(+evt.target.value))}
          value={
            propFormat == "percentage"
              ? lin(value).toFixed(0)
              : value.toFixed(-Math.floor(Math.log10(step)))
          }
        ></input>
        {propFormat == "percentage" ? (
          <div className="input-group-append">
            <span className="input-group-text">%</span>
          </div>
        ) : (
          ""
        )}
      </div>
    );
  } else {
    input = <b>{value.toFixed(-Math.floor(Math.log10(step)))}</b>;
  }

  return (
    <>
      <div
        className="slider"
        style={{
          gridColumn: 3,
          gridRow: row,
          filter: disabled ? "brightness(50%)" : "none",
        }}
      >
        <span className="ruler-label">
          {direction == "rtl" ? format(max) : format(min)}
        </span>
        <input
          className="ruler measure-slider"
          type="range"
          value={propValue ?? undefined}
          disabled={onChange === undefined}
          min={propMin}
          max={propMax}
          step="any"
          onChange={onChange ? (evt) => onChange(+evt.target.value) : undefined}
          style={{
            // @ts-ignore
            "--ruler-background": background,
            direction: direction ?? "ltr",
          }}
        ></input>
        <span className="ruler-label">
          {direction == "rtl" ? format(min) : format(max)}
        </span>
      </div>
      <div
        key={`value-${row}`}
        className="value"
        style={{
          // @ts-ignore
          gridColumn: 4,
          gridRow: row,
          filter: disabled ? "brightness(50%)" : "none",
          justifySelf: "end",
        }}
      >
        {input}
      </div>
    </>
  );
}

type LabeledCheckboxProps = {
  id: string;
  disabled: boolean;
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
};

function LabeledCheckbox({
  id,
  disabled,
  checked,
  onChange,
  label,
}: LabeledCheckboxProps) {
  return (
    <>
      <input
        id={id}
        className="form-check-input"
        type="checkbox"
        disabled={disabled}
        checked={checked}
        onChange={() => onChange(!checked)}
      />{" "}
      <label className="form-check-label" htmlFor={id}>
        {label}
      </label>
    </>
  );
}

type CommonMeasureProps = {
  disabled: boolean;
  rowStart: number;
};

function SingleMeasure(
  props: CommonMeasureProps & {
    measure: Measure;
    checked: boolean;
    subMeasure?: boolean;
    value: number;
    dispatch: React.Dispatch<{ value?: number; checked?: number }>;
  }
) {
  const { checked, measure, disabled, rowStart, dispatch, value } = props;
  const row = rowStart;

  const subMeasure = props.subMeasure ?? false;

  let { mean, p90 } = measure;
  let sd = (p90 - mean) / 1.65;

  const { min, max } = range;

  const limitMin = mean + changeLimit.min;
  const limitMax = mean + changeLimit.max;

  return (
    <>
      <div
        className="label form-check"
        style={{
          // @ts-ignore
          gridColumn: subMeasure ? "2" : "1 / span 2",
          gridRow: row,
        }}
      >
        <LabeledCheckbox
          label={measure.name}
          id={`mitigation-calculator-row-${row}`}
          disabled={disabled}
          checked={checked}
          onChange={() => dispatch({ checked: checked ? 0 : 1 })}
        />
      </div>
      <FancySlider
        row={row}
        min={min}
        max={max}
        format="percentage"
        mean={mean}
        step={0.01}
        sd={sd}
        initial={measure.mean}
        value={value}
        disabled={!checked}
        direction="rtl"
        ticks={true}
        onChange={(value) => {
          if (disabled) return;
          console.log("slider changes: %s %s %s", value, limitMin, limitMax);
          if (value < limitMin) return;
          if (value > limitMax) return;
          dispatch({ value });
        }}
      />
    </>
  );
}

function GroupedMeasures(
  props: CommonMeasureProps & {
    group: MeasureGroup;
    checked: number;
    checkCount: number;
    values: Array<number>;
    dispatch: React.Dispatch<{ value?: Array<number>; checked?: number }>;
  }
) {
  const {
    group,
    checkCount,
    disabled,
    values,
    rowStart: row,
    dispatch,
  } = props;

  function updateValue(idx: number, value: number) {
    dispatch({
      value: values.map((current, i) => (i === idx ? value : current)),
    });
  }

  let measures = group.items.map((measure, i) => {
    let value = values[i];
    let checked = i < checkCount;

    return (
      <SingleMeasure
        disabled={disabled}
        key={i}
        subMeasure
        value={value}
        checked={checked}
        measure={measure}
        rowStart={row + i}
        dispatch={(obj) => {
          if (obj.value) {
            updateValue(i, obj.value);
          }

          if (obj.checked === 1) {
            dispatch({ checked: i + 1 });
          } else if (obj.checked === 0) {
            dispatch({ checked: i });
          }
        }}
      />
    );
  });

  return (
    <>
      <div
        key="label"
        className="label form-check"
        style={{
          gridColumn: "1",
          gridRow: row,
          // gridRow: `span ${measures.length}`,
        }}
      >
        <LabeledCheckbox
          label={group.name}
          id={`mitigation-calculator-group-${row}`}
          disabled={disabled}
          checked={checkCount > 0}
          onChange={(newValue) => {
            dispatch({ checked: newValue ? group.items.length : 0 });
          }}
        />
      </div>

      {measures}
      <div
        className="group-explanation"
        style={{
          gridColumn: 1,
          gridRow: `${row + 1} / span ${measures.length - 1}`,
        }}
      >
        The effects of these measures are cumulative
      </div>
    </>
  );
}

type SliderState = {
  value: number | number[];
  checked: number;
};

type Props = {
  measures: Array<Measure | MeasureGroup>;
  serialInterval: number;
};

export function Page(props: Props) {
  let { measures, serialInterval } = props;

  React.useEffect(() => {
    document.getElementById("containmentContent")?.classList.remove("d-none");
  });

  function reducer<T>(
    state: Array<SliderState>,
    action: { idx: number } & Partial<SliderState>
  ): Array<SliderState> {
    let { idx, checked } = action;

    let newState: Array<SliderState> = state.map((item, i) => {
      if (idx === i) {
        return { ...item, ...action };
      } else {
        return { ...item };
      }
    });

    if (checked === 0) {
      newState.forEach((item, i) => {
        let measure = measures[i];
        if ("implies" in measure && measure.implies) {
          let inconsistent = measure.implies.some(
            (target) => target.key === idx && checked! < (target.value ?? 1)
          );
          if (inconsistent) {
            item.checked = 0;
          }
        }
      });
    } else if (checked === 1) {
      let measure = measures[idx];
      if ("implies" in measure && measure.implies) {
        measure.implies.forEach((target) => {
          let item = newState[target.key];
          item.checked = Math.max(item.checked, target.value ?? 1);
        });
      }
    }

    return newState;
  }

  let [state, dispatch] = React.useReducer(
    reducer,
    null,
    (): Array<SliderState> => {
      return measures.map((measureOrGroup) => {
        if ("items" in measureOrGroup) {
          return {
            value: measureOrGroup.items.map((measure) => measure.mean),
            checked: measureOrGroup.items.length,
          };
        } else {
          return {
            value: measureOrGroup.mean,
            checked: 1,
          };
        }
      });
    }
  );

  let checkedMeasures: Array<[string, number]> = [];
  let row = 3;

  let elems = measures.map((measureOrGroup, i) => {
    let { checked, value } = state[i];

    if (value instanceof Array) {
      checkedMeasures = checkedMeasures.concat(
        (measureOrGroup as MeasureGroup).items
          .slice(0, checked)
          .map((item, index) => [
            `${measureOrGroup.name}:${item.name}`,
            (value as Array<number>)[index] - item.mean,
          ])
      );
    } else if (checked > 0) {
      checkedMeasures.push([
        measureOrGroup.name,
        value - (measureOrGroup as Measure).mean,
      ]);
    }

    if ("items" in measureOrGroup) {
      let item = (
        <GroupedMeasures
          key={`row-${i}`}
          rowStart={row}
          checked={checked}
          values={value as Array<number>}
          disabled={false}
          group={measureOrGroup}
          checkCount={checked}
          dispatch={(obj) => dispatch({ ...obj, idx: i })}
        />
      );
      row += measureOrGroup.items.length;
      return item;
    } else {
      let item = (
        <SingleMeasure
          key={`row-${i}`}
          rowStart={row}
          value={value as number}
          disabled={false}
          measure={measureOrGroup}
          checked={checked != 0}
          dispatch={(obj) => {
            dispatch({ ...obj, idx: i });
          }}
        />
      );
      row += 1;
      return item;
    }
  });

  // function setR(R: number) {
  //   setGrowthRate(1 + Math.log(R) / serialInterval);
  // }

  // function growthToR(growth: number) {
  //   return Math.exp(serialInterval * (growth - 1));
  // }

  const defaultR = 3.3; //growthToR(props.defaultOriginalGrowthRate.mean);
  //let defaultRp95 = growthToR(props.defaultOriginalGrowthRate.ci[1]);
  const multiplied = calculateMultiplied(checkedMeasures);
  const multiplier = multiplied ? median(multiplied) : 1;

  const [baselineR, setR] = React.useState(defaultR);

  const stdR = multiplied ? std(multiplied) : 0;
  const ciRPossitive = multiplied
    ? baselineR * (quantileSeq(multiplied, 0.975) as number)
    : 0;
  const ciRNegative = multiplied
    ? baselineR * (quantileSeq(multiplied, 0.025) as number)
    : 0;

  return (
    <>
      <h1>Mitigation calculator</h1>

      <hr />
      <p>
        This tool can be used to calculate the estimated effect of various
        combinations of nonpharmaceutical interventions (NPIs) against COVID-19
        transmission. On the left, intervention and intervention groups can be
        toggled on and off. On the right, the percentage reduction in R is
        displayed using coloured bands to indicate uncertainty. The NPI
        effectiveness estimates are derived in{" "}
        <a href="https://science.sciencemag.org/lookup/doi/10.1126/science.abd9338">
          [Brauner et al, Inferring the effectiveness of government
          interventions against COVID-19.]
        </a>
        . If desired, the effectiveness of each NPI can be manually adjusted to
        account for specific local circumstances in a country.
      </p>
      <p>
        <i>
          <b>Disclaimer:</b> Please refer to the manuscript for a full account
          of the limitations of these effectiveness estimates. Briefly, the
          results of this calculator are based on modelling assumptions and may
          not be valid in some local contexts. The estimates present the impact
          NPIs had between January and the end of May 2020, and NPI
          effectiveness may have changed over time as circumstances have
          changed. In particular, the estimates present the predicted reduction
          in R due to the introduction of specific measures; the effect of
          lifting these measures may not result in an increase in R of the same
          proportion.
        </i>
      </p>
      <hr />
      <div className="measure-calculator">
        <div style={{ gridColumn: "1 / span 2" }}>
          <b>Nonpharmaceutical interventions</b>
        </div>
        <div style={{ gridColumn: "3 / span 2" }}>
          <b>Percentage reduction in R, the reproduction number</b>
        </div>
        {elems}
        <div style={{ gridColumn: "1 / span 2", gridRow: row++ }}>
          <b>Outcome</b>
        </div>
        <div style={{ gridColumn: "1 / span 2", gridRow: row, maxWidth: 300 }}>
          R without any NPIs (R0)
        </div>

        <FancySlider
          min={0}
          row={row++}
          // format={(num) => `R = ${d3.format(".1f")(num)}`}
          value={baselineR}
          step={Math.pow(10, Math.ceil(Math.log10(serialInterval / 4)) - 2)}
          onChange={setR}
          mean={baselineR}
          sd={0}
          max={8}
          direction="ltr"
          ticks={true}
        ></FancySlider>

        <div style={{ gridColumn: "1 / span 2", gridRow: row, maxWidth: 300 }}>
          R when the above NPIs are implemented
        </div>

        <FancySlider
          min={0}
          row={row++}
          value={baselineR * multiplier}
          step={Math.pow(10, Math.ceil(Math.log10(serialInterval / 4)) - 3)}
          mean={baselineR * multiplier}
          scale={chroma.scale("YlOrRd")}
          sd={stdR * baselineR}
          max={8}
          direction="ltr"
          ticks={true}
        ></FancySlider>

        <div style={{ gridColumn: "3", gridRow: row }}>
          <p>The NPIs result in an average change in R of </p>
          <p>95% credible interval for R</p>
        </div>
        <div
          style={{
            gridColumn: "4",
            gridRow: row++,
            justifySelf: "end",
            width: 150,
            textAlign: "right",
          }}
        >
          <p>
            <b>{d3.format(".1%")(multiplier - 1)}</b>
          </p>
          <p>
            <b>
              ({ciRNegative.toFixed(3)}, {ciRPossitive.toFixed(3)})
            </b>
          </p>
        </div>
      </div>
      <hr />
    </>
  );
}

let $root = document.getElementById("react-mitigation-calculator-paper");
if ($root) {
  ReactDOM.render(
    <Page measures={measures} serialInterval={serialInterval} />,
    $root
  );
}
